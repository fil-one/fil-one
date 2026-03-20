#!/usr/bin/env node

// Usage: ./bin/reset-db.ts
//
// Deletes all DynamoDB records from the currently configured SST stage.
// Refuses to run against staging or production.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Re-exec under `sst shell` if SST resources aren't available
if (!process.env.SST_RESOURCE_App) {
  execFileSync('pnpx', ['sst', 'shell', 'node', import.meta.filename], {
    stdio: 'inherit',
  });
  process.exit(0);
}

import { Resource } from 'sst';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DynamoDBClient, ScanCommand, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb';

const PROTECTED_STAGES = ['staging', 'production'];

const stage = readFileSync('.sst/stage', 'utf8').trim();
if (PROTECTED_STAGES.includes(stage)) {
  console.error(`Refusing to delete data from the "${stage}" stage.`);
  process.exit(1);
}

console.log(`Resetting database for stage "${stage}"...`);

const dynamo = new DynamoDBClient({});

const tables: Array<{ name: string; tableName: string }> = [
  { name: 'BillingTable', tableName: Resource.BillingTable.name },
  { name: 'UserInfoTable', tableName: Resource.UserInfoTable.name },
];

for (const { name, tableName } of tables) {
  console.log(`Clearing ${name} (${tableName})...`);
  let deleted = 0;
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const scan = await dynamo.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: 'pk, sk',
        ExclusiveStartKey: lastKey,
      }),
    );

    lastKey = scan.LastEvaluatedKey;
    const items = scan.Items ?? [];
    if (items.length === 0) break;

    // BatchWriteItem supports max 25 items per call
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      await dynamo.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [tableName]: batch.map((item) => ({
              DeleteRequest: { Key: { pk: item.pk, sk: item.sk } },
            })),
          },
        }),
      );
      deleted += batch.length;
    }
  } while (lastKey);

  console.log(`  Deleted ${deleted} items.`);
}

console.log('Done.');
