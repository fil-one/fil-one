#!/usr/bin/env node

// Usage: ./bin/backfill-access-key-granular-permissions.ts [--dry-run]
//
// Migrates existing access key records onto a single flat `permissions` attribute
// holding the S3-action permission set, and removes the legacy `granularPermissions`
// attribute. Access keys moved from a two-level model (basic read/write/list/delete
// tokens in `permissions` plus a PARTIAL S3-action set under `granularPermissions`,
// covering only data-protection perms) to a single flat model where `permissions`
// holds the full S3-action list.
//
// For each record the new value is the UNION of:
//   - expand(basic tokens in record.permissions)  // Aurora's basic->S3 action mapping
//   - S3 actions already in record.permissions     // so re-runs are idempotent
//   - record.granularPermissions ?? []             // preserve already-chosen perms
// deduped in canonical order, written back to `permissions`. Expansion grants ONLY
// the actions Aurora documents for each basic permission — version/retention/legal-hold
// perms are never added for a legacy key that didn't already have them. The write is
// idempotent: an already-migrated row (whose `permissions` holds S3 actions) recomputes
// to the same set, and the legacy `granularPermissions` attribute is removed.
//
// Run against the stage recorded in .sst/stage (e.g. your personal dev stack):
//   ./bin/backfill-access-key-granular-permissions.ts --dry-run
//   ./bin/backfill-access-key-granular-permissions.ts
//
// Target staging (AWS account 654654381893):
//   pnpx sst shell --stage staging -- node ./bin/backfill-access-key-granular-permissions.ts --dry-run
//   pnpx sst shell --stage staging -- node ./bin/backfill-access-key-granular-permissions.ts
//
// Target production (AWS account 811430801166):
//   pnpx sst shell --stage production -- node ./bin/backfill-access-key-granular-permissions.ts --dry-run
//   pnpx sst shell --stage production -- node ./bin/backfill-access-key-granular-permissions.ts
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

// Inlined to keep this script self-contained — it must NOT import from
// @filone/shared. Each legacy basic permission expands to exactly the S3 actions
// Aurora documents for it (see AccesskeysAccessKeyRequest in
// packages/aurora-portal-client/src/generated/types.gen.ts):
//   Read   -> [GetObject, ListMultipartUploadParts]
//   Write  -> [PutObject, AbortMultipartUpload]
//   Delete -> [DeleteObject]
//   List   -> [ListBucket, ListBucketMultipartUploads]
// The version/retention/legal-hold permissions are separate, individually-opted
// permissions — they are NOT part of the basic expansion and are never added here.
type BasicPermission = 'read' | 'write' | 'list' | 'delete';
type AccessKeyPermission =
  | 'GetObject'
  | 'ListMultipartUploadParts'
  | 'GetObjectVersion'
  | 'GetObjectRetention'
  | 'GetObjectLegalHold'
  | 'PutObject'
  | 'AbortMultipartUpload'
  | 'PutObjectRetention'
  | 'PutObjectLegalHold'
  | 'ListBucket'
  | 'ListBucketMultipartUploads'
  | 'ListBucketVersions'
  | 'DeleteObject'
  | 'DeleteObjectVersion';

const ACCESS_KEY_PERMISSION_MAP: Record<BasicPermission, AccessKeyPermission[]> = {
  read: ['GetObject', 'ListMultipartUploadParts'],
  write: ['PutObject', 'AbortMultipartUpload'],
  list: ['ListBucket', 'ListBucketMultipartUploads'],
  delete: ['DeleteObject'],
};

// Canonical ordering used to produce a stable, deduped union.
const ACCESS_KEY_PERMISSION_ORDER: AccessKeyPermission[] = [
  'GetObject',
  'ListMultipartUploadParts',
  'GetObjectVersion',
  'GetObjectRetention',
  'GetObjectLegalHold',
  'PutObject',
  'AbortMultipartUpload',
  'PutObjectRetention',
  'PutObjectLegalHold',
  'ListBucket',
  'ListBucketMultipartUploads',
  'ListBucketVersions',
  'DeleteObject',
  'DeleteObjectVersion',
];

// Membership sets used to classify whatever currently sits in `permissions`:
// legacy rows hold basic tokens, already-migrated rows hold S3 actions.
const BASIC_PERMISSIONS = new Set<string>(Object.keys(ACCESS_KEY_PERMISSION_MAP));
const S3_ACTIONS = new Set<string>(ACCESS_KEY_PERMISSION_ORDER);

const dryRun = process.argv.includes('--dry-run');
const tableName = Resource.UserInfoTable.name;
const stage = readFileSync('.sst/stage', 'utf8').trim();
const dynamo = new DynamoDBClient({});

console.log(
  `${dryRun ? 'DRY-RUN — ' : ''}Backfilling permissions on ${tableName} (stage="${stage}")`,
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

    // `permissions` may hold legacy basic tokens (expand them) or — on an
    // already-migrated row — S3 actions (carry them through). Union with any
    // perms preserved under the legacy `granularPermissions` attribute, deduped
    // in canonical order for a stable, idempotent result.
    const expandedBasic = rawPermissions
      .filter((p) => BASIC_PERMISSIONS.has(p))
      .flatMap((p) => ACCESS_KEY_PERMISSION_MAP[p as BasicPermission]);
    const s3InPermissions = rawPermissions.filter((p) => S3_ACTIONS.has(p));
    const s3InGranular = rawGranular.filter((p) => S3_ACTIONS.has(p));

    const union = new Set<string>([...expandedBasic, ...s3InPermissions, ...s3InGranular]);
    const permissions = ACCESS_KEY_PERMISSION_ORDER.filter((p) => union.has(p));

    const keyName = record.keyName ?? '(no name)';

    if (permissions.length === 0) {
      console.warn(
        `  Skipping ${record.pk}/${record.sk} keyName="${keyName}": no recognizable permissions`,
      );
      skippedInvalid++;
      continue;
    }

    console.log(
      `  ${dryRun ? '[dry-run] ' : ''}${record.pk} ${record.sk} keyName="${keyName}" from=[${rawPermissions.join(',')}] -> permissions=[${permissions.join(',')}]`,
    );

    if (dryRun) {
      updated++;
      continue;
    }

    // Idempotent write: set the computed S3-action set under `permissions` and
    // drop the legacy `granularPermissions` attribute. `permissions` is a DynamoDB
    // reserved word, so it is referenced via an expression-attribute-name alias.
    await dynamo.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: item.pk!, sk: item.sk! },
        UpdateExpression: 'SET #permissions = :p REMOVE granularPermissions',
        ExpressionAttributeNames: { '#permissions': 'permissions' },
        ExpressionAttributeValues: marshall({ ':p': permissions }),
      }),
    );
    updated++;
  }
} while (lastKey);

console.log('');
console.log(`Scanned: ${scanned}`);
console.log(`${dryRun ? 'Would update' : 'Updated'}: ${updated}`);
if (skippedInvalid > 0) console.log(`Skipped (invalid permissions): ${skippedInvalid}`);
console.log('Done.');
