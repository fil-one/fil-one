#!/usr/bin/env node

// Usage: ./bin/backfill-access-key-granular-permissions.ts [--dry-run]
//
// Backfills the access-key permission set on existing access key records in
// DynamoDB and migrates it onto the `accessKeyPermissions` attribute (the
// attribute was formerly named `granularPermissions`). Access keys moved from a
// two-level model (basic read/write/list/delete `permissions` plus a partial
// permission set covering only data-protection perms) to a single flat model.
// Legacy records store basic `permissions` and may carry a PARTIAL permission
// set under the old `granularPermissions` attribute. This script writes the
// equivalent permission set under `accessKeyPermissions` (removing the old
// attribute) so the read path and the UI display correctly.
//
// For each record the new value is the UNION of:
//   - expand(record.permissions)              // Aurora's basic->S3 action mapping
//   - record.accessKeyPermissions ??          // preserve already-chosen perms,
//       record.granularPermissions ?? []      //   tolerating either attribute name
// deduped in canonical order. Expansion grants ONLY the actions Aurora documents
// for each basic permission — version/retention/legal-hold perms are never added
// for a legacy key that didn't already have them. The write is unconditional and
// idempotent: records previously backfilled with the partial set are recomputed
// and overwritten, and the legacy `granularPermissions` attribute is removed.
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

const dryRun = process.argv.includes('--dry-run');
const tableName = Resource.UserInfoTable.name;
const stage = readFileSync('.sst/stage', 'utf8').trim();
const dynamo = new DynamoDBClient({});

console.log(
  `${dryRun ? 'DRY-RUN — ' : ''}Backfilling accessKeyPermissions on ${tableName} (stage="${stage}")`,
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

    const permissions = record.permissions as BasicPermission[] | undefined;
    if (!Array.isArray(permissions) || permissions.length === 0) {
      console.warn(`  Skipping ${record.pk}/${record.sk}: permissions missing or empty`);
      skippedInvalid++;
      continue;
    }

    // Preserve already-chosen perms, tolerating either attribute name on the
    // record (new `accessKeyPermissions` or legacy `granularPermissions`).
    const existingPermissions = Array.isArray(record.accessKeyPermissions)
      ? (record.accessKeyPermissions as AccessKeyPermission[])
      : Array.isArray(record.granularPermissions)
        ? (record.granularPermissions as AccessKeyPermission[])
        : [];

    // Union of the full expansion of the basic perms with any perms already
    // chosen (e.g. data-protection perms from the partial backfill), deduped in
    // canonical order for a stable result.
    const union = new Set<AccessKeyPermission>([
      ...permissions.flatMap((p) => ACCESS_KEY_PERMISSION_MAP[p] ?? []),
      ...existingPermissions,
    ]);
    const accessKeyPermissions = ACCESS_KEY_PERMISSION_ORDER.filter((p) => union.has(p));

    const keyName = record.keyName ?? '(no name)';
    console.log(
      `  ${dryRun ? '[dry-run] ' : ''}${record.pk} ${record.sk} keyName="${keyName}" perms=[${permissions.join(',')}] -> accessKeyPermissions=[${accessKeyPermissions.join(',')}]`,
    );

    if (dryRun) {
      updated++;
      continue;
    }

    // Unconditional, idempotent write: always set the computed full permission
    // set under the new attribute and drop the legacy `granularPermissions` one.
    await dynamo.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: item.pk!, sk: item.sk! },
        UpdateExpression: 'SET accessKeyPermissions = :g REMOVE granularPermissions',
        ExpressionAttributeValues: marshall({ ':g': accessKeyPermissions }),
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
