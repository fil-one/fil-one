// A single lock row that keeps two writing runs off the same tables.
//
// The conversion and the revert move the same rows in opposite directions, and
// a revert that lands between the conversion's OrgTable transaction and its
// legacy-row delete leaves the org with neither membership. One row in OrgTable
// makes that impossible: every `--execute` run of either script takes it first
// and drops it on the way out.
//
// The key sits outside both scans' filters (`ORG#`, `USER#`), so the lock is
// invisible to everything that reads membership.

import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import { decodeRow, text } from './dynamo.ts';

export const RUN_LOCK_PK = 'CONVERSION#LOCK';
export const RUN_LOCK_SK = 'LOCK';

const lockKey = (): Record<string, AttributeValue> => ({
  pk: { S: RUN_LOCK_PK },
  sk: { S: RUN_LOCK_SK },
});

/** What the lock row records about the run holding it. */
interface LockRow {
  runId: string;
  script: string;
  stage: string;
  startedAt: string;
  host: string;
  pid: string;
}

export interface RunLock {
  /** Drop the lock. Safe to call after a failure; a lock someone else now holds is left alone. */
  release(): Promise<void>;
}

/**
 * Take the lock, or name the run that holds it and stop.
 *
 * The delete is conditional on the same `runId` the put wrote, so a run that
 * overran a `--force-unlock` cannot drop the lock its successor is holding.
 */
export async function acquireRunLock(
  client: DynamoDBClient,
  tableName: string,
  context: { script: string; stage: string },
): Promise<RunLock> {
  const runId = randomUUID();

  try {
    await client.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          ...lockKey(),
          runId: { S: runId },
          script: { S: context.script },
          stage: { S: context.stage },
          startedAt: { S: new Date().toISOString() },
          host: { S: hostname() },
          pid: { S: String(process.pid) },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    await reportHolder(client, tableName);
    process.exit(1);
  }

  return {
    async release(): Promise<void> {
      try {
        await client.send(
          new DeleteItemCommand({
            TableName: tableName,
            Key: lockKey(),
            ConditionExpression: '#runId = :runId',
            ExpressionAttributeNames: { '#runId': 'runId' },
            ExpressionAttributeValues: { ':runId': { S: runId } },
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        console.warn('  Run lock was taken over by another run — left in place.');
      }
    },
  };
}

/** Drop a lock a crashed run left behind. Prints what it removed, or that there was nothing. */
export async function forceUnlock(client: DynamoDBClient, tableName: string): Promise<void> {
  const holder = await readLock(client, tableName);
  if (!holder) {
    console.log('No run lock held.');
    return;
  }

  await client.send(new DeleteItemCommand({ TableName: tableName, Key: lockKey() }));
  console.log(`Released the run lock held by ${describeHolder(holder)}.`);
}

async function readLock(
  client: DynamoDBClient,
  tableName: string,
): Promise<Partial<LockRow> | undefined> {
  const { Item } = await client.send(
    new GetItemCommand({ TableName: tableName, Key: lockKey(), ConsistentRead: true }),
  );
  return Item ? decodeRow<LockRow>(Item) : undefined;
}

async function reportHolder(client: DynamoDBClient, tableName: string): Promise<void> {
  const holder = await readLock(client, tableName);
  console.error(
    holder
      ? `Another run holds the lock: ${describeHolder(holder)}.`
      : 'Another run holds the lock (it was released while this one was reporting it).',
  );
  console.error(
    'Wait for it to finish. If it crashed, drop the lock with --force-unlock and re-run.',
  );
}

function describeHolder(holder: Partial<LockRow>): string {
  const script = text(holder.script) ?? '(unknown script)';
  const stage = text(holder.stage) ?? '(unknown stage)';
  const startedAt = text(holder.startedAt) ?? '(unknown time)';
  const host = text(holder.host) ?? '(unknown host)';
  const pid = text(holder.pid) ?? '?';
  return `${script} --stage ${stage}, started ${startedAt} on ${host} (pid ${pid})`;
}
