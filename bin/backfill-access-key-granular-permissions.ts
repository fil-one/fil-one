#!/usr/bin/env node

// Usage: ./bin/backfill-access-key-granular-permissions.ts [--dry-run]
//
// Backfills the FULL `granularPermissions` set on existing access key records
// in DynamoDB. Access keys are moving from a two-level model (basic
// read/write/list/delete `permissions` plus a partial `granularPermissions`
// set covering only data-protection perms) to a single granular-only model.
// Legacy records store basic `permissions` and may carry a PARTIAL
// `granularPermissions` set. This script writes the full granular set so the
// granular-only read path and the UI display correctly.
//
// For each record the new value is the UNION of:
//   - expand(record.permissions)        // full granular per basic perm held
//   - record.granularPermissions ?? []  // preserve already-chosen data-protection perms
// deduped in the canonical 14-permission order. The write is unconditional and
// idempotent: records previously backfilled with the partial set are recomputed
// and overwritten.
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
// @filone/shared. This is the inverse of the new backend translators: the
// FULL base->granular expansion (14 granular permissions across 4 basic ones).
// Keep in sync with packages/shared/src/api/access-keys.ts if that map changes.
type AccessKeyPermission = 'read' | 'write' | 'list' | 'delete';
type GranularPermission =
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

const GRANULAR_PERMISSION_MAP: Record<AccessKeyPermission, GranularPermission[]> = {
  read: [
    'GetObject',
    'ListMultipartUploadParts',
    'GetObjectVersion',
    'GetObjectRetention',
    'GetObjectLegalHold',
  ],
  write: ['PutObject', 'AbortMultipartUpload', 'PutObjectRetention', 'PutObjectLegalHold'],
  list: ['ListBucket', 'ListBucketMultipartUploads', 'ListBucketVersions'],
  delete: ['DeleteObject', 'DeleteObjectVersion'],
};

// Canonical ordering used to produce a stable, deduped union.
const GRANULAR_PERMISSION_ORDER: GranularPermission[] = [
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

const dryRun = process.argv.includes('--dry-run');
const tableName = Resource.UserInfoTable.name;
const stage = readFileSync('.sst/stage', 'utf8').trim();
const dynamo = new DynamoDBClient({});

console.log(
  `${dryRun ? 'DRY-RUN — ' : ''}Backfilling granularPermissions on ${tableName} (stage="${stage}")`,
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

    const permissions = record.permissions as AccessKeyPermission[] | undefined;
    if (!Array.isArray(permissions) || permissions.length === 0) {
      console.warn(`  Skipping ${record.pk}/${record.sk}: permissions missing or empty`);
      skippedInvalid++;
      continue;
    }

    const existingGranular = Array.isArray(record.granularPermissions)
      ? (record.granularPermissions as GranularPermission[])
      : [];

    // Union of the full expansion of the basic perms with any granular perms
    // already chosen (e.g. data-protection perms from the partial backfill),
    // deduped in canonical order for a stable result.
    const union = new Set<GranularPermission>([
      ...permissions.flatMap((p) => GRANULAR_PERMISSION_MAP[p] ?? []),
      ...existingGranular,
    ]);
    const granular = GRANULAR_PERMISSION_ORDER.filter((p) => union.has(p));

    const keyName = record.keyName ?? '(no name)';
    console.log(
      `  ${dryRun ? '[dry-run] ' : ''}${record.pk} ${record.sk} keyName="${keyName}" perms=[${permissions.join(',')}] -> granular=[${granular.join(',')}]`,
    );

    if (dryRun) {
      updated++;
      continue;
    }

    // Unconditional, idempotent write: always set the computed full granular
    // set so records previously backfilled with the partial set are recomputed.
    await dynamo.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: item.pk!, sk: item.sk! },
        UpdateExpression: 'SET granularPermissions = :g',
        ExpressionAttributeValues: marshall({ ':g': granular }),
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
