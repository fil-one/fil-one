#!/usr/bin/env node

// Usage: ./bin/backfill-access-key-granular-permissions.ts [--dry-run]
//
// Backfills the `granularPermissions` field on existing access key records
// in DynamoDB. Keys created before the granular-permissions feature were
// implicitly granted the full granular set at the Aurora policy level but
// lack the attribute in DynamoDB, so the UI shows them with no granular
// permissions selected. This script writes the expanded set derived from
// each key's basic permissions via GRANULAR_PERMISSION_MAP. Uses a
// conditional update so re-runs and keys that already have an explicit
// choice are untouched.
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
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

// Inlined from packages/shared/src/api/access-keys.ts — keep in sync if that map changes.
type AccessKeyPermission = 'read' | 'write' | 'list' | 'delete';
type GranularPermission =
  | 'GetObjectVersion'
  | 'GetObjectRetention'
  | 'GetObjectLegalHold'
  | 'PutObjectRetention'
  | 'PutObjectLegalHold'
  | 'ListBucketVersions'
  | 'DeleteObjectVersion';

const GRANULAR_PERMISSION_MAP: Record<AccessKeyPermission, GranularPermission[]> = {
  read: ['GetObjectVersion', 'GetObjectRetention', 'GetObjectLegalHold'],
  write: ['PutObjectRetention', 'PutObjectLegalHold'],
  list: ['ListBucketVersions'],
  delete: ['DeleteObjectVersion'],
};

const dryRun = process.argv.includes('--dry-run');
const tableName = Resource.UserInfoTable.name;
const stage = readFileSync('.sst/stage', 'utf8').trim();
const dynamo = new DynamoDBClient({});

console.log(
  `${dryRun ? 'DRY-RUN — ' : ''}Backfilling granularPermissions on ${tableName} (stage="${stage}")`,
);

let scanned = 0;
let updated = 0;
let alreadyHadField = 0;
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

    if (Array.isArray(record.granularPermissions)) {
      alreadyHadField++;
      continue;
    }

    const permissions = record.permissions as AccessKeyPermission[] | undefined;
    if (!Array.isArray(permissions) || permissions.length === 0) {
      console.warn(`  Skipping ${record.pk}/${record.sk}: permissions missing or empty`);
      skippedInvalid++;
      continue;
    }

    const granular = Array.from(
      new Set(permissions.flatMap((p) => GRANULAR_PERMISSION_MAP[p] ?? [])),
    );

    const keyName = record.keyName ?? '(no name)';
    console.log(
      `  ${dryRun ? '[dry-run] ' : ''}${record.pk} ${record.sk} keyName="${keyName}" perms=[${permissions.join(',')}] -> granular=[${granular.join(',')}]`,
    );

    if (dryRun) {
      updated++;
      continue;
    }

    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { pk: item.pk!, sk: item.sk! },
          UpdateExpression: 'SET granularPermissions = :g',
          ConditionExpression: 'attribute_not_exists(granularPermissions)',
          ExpressionAttributeValues: marshall({ ':g': granular }),
        }),
      );
      updated++;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        alreadyHadField++;
      } else {
        throw err;
      }
    }
  }
} while (lastKey);

console.log('');
console.log(`Scanned: ${scanned}`);
console.log(`${dryRun ? 'Would update' : 'Updated'}: ${updated}`);
console.log(`Already had granularPermissions: ${alreadyHadField}`);
if (skippedInvalid > 0) console.log(`Skipped (invalid permissions): ${skippedInvalid}`);
console.log('Done.');
