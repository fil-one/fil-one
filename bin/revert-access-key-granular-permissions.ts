#!/usr/bin/env node

// Usage: ./bin/revert-access-key-granular-permissions.ts [--dry-run]
//
// Reverts the changes made by ./bin/backfill-access-key-granular-permissions.ts,
// restoring the two-level access-key permission model (basic read/write/list/delete
// tokens in `permissions`, plus a data-protection S3-action set under
// `granularPermissions`) that the codebase reads again after PR #462 reverts #446.
//
// The backfill collapsed each ACCESSKEY# record onto a single flat `permissions`
// attribute by (1) expanding the basic tokens to their base S3 actions and (2)
// folding the legacy `granularPermissions` attribute into `permissions` and removing
// it. That is cleanly reversible: the 14 S3 actions partition into two DISJOINT sets,
// so no information was lost for migrated legacy rows.
//
//   Base actions (from basic-token expansion) -> reverse to a basic token:
//     GetObject, ListMultipartUploadParts        -> read
//     PutObject, AbortMultipartUpload            -> write
//     ListBucket, ListBucketMultipartUploads     -> list
//     DeleteObject                               -> delete
//   Data-protection actions (the old granularPermissions) -> restored verbatim:
//     GetObjectVersion, GetObjectRetention, GetObjectLegalHold,
//     PutObjectRetention, PutObjectLegalHold, ListBucketVersions, DeleteObjectVersion
//
// 7 base + 7 data-protection = all 14 actions, so every migrated action is accounted
// for and nothing is silently dropped. For each record the new value is:
//   permissions          = canonical(reverse-map(base actions) ∪ basic tokens already present)
//   granularPermissions  = canonical(data-protection actions in `permissions`
//                                     ∪ any existing `granularPermissions`)
// The write is idempotent: an already-reverted row (whose `permissions` holds basic
// tokens) recomputes to the same set, and the data-protection attribute is rebuilt
// from the restored `granularPermissions`.
//
// KNOWN, ACCEPTED IMPRECISION: keys created after PR #446 via the flat UI may hold a
// partial pair (e.g. the "Read-only" preset [GetObject, ListBucket]). These reverse to
// ['read','list']; under the two-level backend, read/list grant their full action set —
// a minor OVER-GRANT versus the exact flat selection. This is unavoidable in the coarse
// two-level model and is the intended behaviour of reverting to the prior model.
//
// Run against the stage recorded in .sst/stage (e.g. your personal dev stack):
//   ./bin/revert-access-key-granular-permissions.ts --dry-run
//   ./bin/revert-access-key-granular-permissions.ts
//
// Target staging (AWS account 654654381893):
//   pnpx sst shell --stage staging -- node ./bin/revert-access-key-granular-permissions.ts --dry-run
//   pnpx sst shell --stage staging -- node ./bin/revert-access-key-granular-permissions.ts
//
// Target production (AWS account 811430801166):
//   pnpx sst shell --stage production -- node ./bin/revert-access-key-granular-permissions.ts --dry-run
//   pnpx sst shell --stage production -- node ./bin/revert-access-key-granular-permissions.ts
//
// There is no DynamoDB PITR/backup, so the per-row `before -> after` log is the only
// audit trail — capture stdout when running for real, e.g. `... | tee revert.log`.
//
// The `--` between `--stage <name>` and `node` keeps `sst shell` from parsing
// `--dry-run` as one of its own flags. Confirm the stage printed at startup
// before running without --dry-run.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Re-exec under `sst shell` if SST resources aren't available
if (!process.env.SST_RESOURCE_App) {
  execFileSync(
    'pnpx',
    ['sst', 'shell', '--', 'node', import.meta.filename, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(0);
}

import { Resource } from 'sst';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DynamoDBClient, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

// Inlined to keep this script self-contained — it must NOT import from @filone/shared.
// Reverse of the backfill's basic->S3 expansion: each base S3 action maps back to the
// single basic token it was expanded from (see ACCESS_KEY_PERMISSION_MAP in
// bin/backfill-access-key-granular-permissions.ts).
type BasicPermission = 'read' | 'write' | 'list' | 'delete';

const BASE_ACTION_TO_BASIC: Record<string, BasicPermission> = {
  GetObject: 'read',
  ListMultipartUploadParts: 'read',
  PutObject: 'write',
  AbortMultipartUpload: 'write',
  ListBucket: 'list',
  ListBucketMultipartUploads: 'list',
  DeleteObject: 'delete',
};

// Canonical ordering for the restored basic-token set.
const BASIC_ORDER: BasicPermission[] = ['read', 'write', 'list', 'delete'];

// The legacy data-protection (granular) permissions, in canonical order. These are
// disjoint from the base actions above and are restored verbatim to `granularPermissions`.
const GRANULAR_ORDER: string[] = [
  'GetObjectVersion',
  'GetObjectRetention',
  'GetObjectLegalHold',
  'PutObjectRetention',
  'PutObjectLegalHold',
  'ListBucketVersions',
  'DeleteObjectVersion',
];

// Membership sets used to classify whatever currently sits in `permissions`. An
// already-reverted row holds basic tokens; a not-yet-reverted row holds S3 actions.
const GRANULAR_SET = new Set<string>(GRANULAR_ORDER);
const BASIC_TOKENS = new Set<string>(BASIC_ORDER);

const dryRun = process.argv.includes('--dry-run');
const tableName = Resource.UserInfoTable.name;
const stage = readFileSync('.sst/stage', 'utf8').trim();
const dynamo = new DynamoDBClient({});

console.log(
  `${dryRun ? 'DRY-RUN — ' : ''}Reverting permissions on ${tableName} (stage="${stage}")`,
);

let scanned = 0;
let updated = 0;
let skippedInvalid = 0;
let lastKey: Record<string, AttributeValue> | undefined;

do {
  const result = await dynamo.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: 'begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: { ':skPrefix': { S: 'ACCESSKEY#' } },
      ExclusiveStartKey: lastKey,
    }),
  );
  lastKey = result.LastEvaluatedKey;

  for (const item of result.Items ?? []) {
    scanned++;
    const record = unmarshall(item);

    const rawPermissions = Array.isArray(record.permissions)
      ? (record.permissions as string[])
      : [];
    const rawGranular = Array.isArray(record.granularPermissions)
      ? (record.granularPermissions as string[])
      : [];

    // `permissions` may hold base S3 actions (reverse them to basic tokens) or — on an
    // already-reverted row — basic tokens (carry them through). Data-protection actions
    // are pulled out of `permissions` and unioned with any existing `granularPermissions`,
    // deduped in canonical order for a stable, idempotent result.
    const basicAlready = rawPermissions.filter((p) => BASIC_TOKENS.has(p));
    const reversedBasic = rawPermissions
      .filter((p) => p in BASE_ACTION_TO_BASIC)
      .map((p) => BASE_ACTION_TO_BASIC[p]);
    const basicUnion = new Set<string>([...basicAlready, ...reversedBasic]);
    const permissions = BASIC_ORDER.filter((t) => basicUnion.has(t));

    const granularUnion = new Set<string>([
      ...rawPermissions.filter((p) => GRANULAR_SET.has(p)),
      ...rawGranular.filter((p) => GRANULAR_SET.has(p)),
    ]);
    const granularPermissions = GRANULAR_ORDER.filter((p) => granularUnion.has(p));

    const keyName = record.keyName ?? '(no name)';

    if (permissions.length === 0) {
      console.warn(
        `  Skipping ${record.pk}/${record.sk} keyName="${keyName}": no recognizable base permissions (current=[${rawPermissions.join(',')}])`,
      );
      skippedInvalid++;
      continue;
    }

    console.log(
      `  ${dryRun ? '[dry-run] ' : ''}${record.pk} ${record.sk} keyName="${keyName}" from=[${rawPermissions.join(',')}] -> permissions=[${permissions.join(',')}] granularPermissions=[${granularPermissions.join(',')}]`,
    );

    if (dryRun) {
      updated++;
      continue;
    }

    // Restore the two-level shape: set basic tokens under `permissions`, and either
    // restore the `granularPermissions` attribute or REMOVE it (the latter guards
    // against a half-applied prior run leaving a stale attribute). `permissions` is a
    // DynamoDB reserved word, so it is referenced via an expression-attribute-name alias.
    const command =
      granularPermissions.length > 0
        ? new UpdateItemCommand({
            TableName: tableName,
            Key: { pk: item.pk!, sk: item.sk! },
            UpdateExpression: 'SET #permissions = :p, granularPermissions = :g',
            ExpressionAttributeNames: { '#permissions': 'permissions' },
            ExpressionAttributeValues: marshall({ ':p': permissions, ':g': granularPermissions }),
          })
        : new UpdateItemCommand({
            TableName: tableName,
            Key: { pk: item.pk!, sk: item.sk! },
            UpdateExpression: 'SET #permissions = :p REMOVE granularPermissions',
            ExpressionAttributeNames: { '#permissions': 'permissions' },
            ExpressionAttributeValues: marshall({ ':p': permissions }),
          });

    await dynamo.send(command);
    updated++;
  }
} while (lastKey);

console.log('');
console.log(`Scanned: ${scanned}`);
console.log(`${dryRun ? 'Would update' : 'Updated'}: ${updated}`);
if (skippedInvalid > 0)
  console.log(`Skipped (no recognizable base permissions): ${skippedInvalid}`);
console.log('Done.');
