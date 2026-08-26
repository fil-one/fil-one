// A single lock row that keeps two writing runs off the same tables.
//
// The conversion and the revert move the same rows in opposite directions, and
// a revert that lands between the conversion's OrgTable transaction and its
// legacy-row delete leaves the org with neither membership. One row makes that
// impossible: every `--execute` run of either script takes it first and drops
// it on the way out. The billing re-key and its own revert share a second lock
// on the same terms.
//
// Each lock's key sits outside the scans of the migration it guards — `ORG#`
// and `USER#` for membership, `sk = SUBSCRIPTION` for billing — so a lock row
// is invisible to everything that reads real data.

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

/**
 * The billing re-key's lock. Its own row rather than the conversion's: the two
 * migrations write different tables and may legitimately be in flight in the
 * same week, and one lock would make them queue behind each other for no
 * reason. `sk` stays `LOCK`, which no `sk = SUBSCRIPTION` scan matches.
 */
export const BILLING_REKEY_LOCK_PK = 'BILLING_REKEY#LOCK';

const lockKey = (pk: string): Record<string, AttributeValue> => ({
  pk: { S: pk },
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

/** What a `--force-unlock` has to name to be sure it is dropping the lock it just read. */
export interface ForceUnlockOptions {
  /** Only drop the lock if this run still holds it. */
  runId?: string;
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
  context: { script: string; stage: string; lockPk?: string },
): Promise<RunLock> {
  const runId = randomUUID();
  const pk = context.lockPk ?? RUN_LOCK_PK;

  try {
    await client.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          ...lockKey(pk),
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
    await reportHolder(client, tableName, pk);
    process.exit(1);
  }

  return {
    async release(): Promise<void> {
      try {
        await client.send(
          new DeleteItemCommand({
            TableName: tableName,
            Key: lockKey(pk),
            ConditionExpression: '#runId = :runId',
            ExpressionAttributeNames: { '#runId': 'runId' },
            ExpressionAttributeValues: { ':runId': { S: runId } },
          }),
        );
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
        // Either somebody force-unlocked this run and another took the lock, or
        // the row is simply gone. Both mean this run no longer holds it, and
        // saying so is the difference between a clean exit and one that looks
        // clean.
        const holder = await readLock(client, tableName, pk);
        console.warn(
          holder
            ? `  Run lock is no longer this run's — now held by ${describeHolder(holder)}; left in place.`
            : '  Run lock was already released (force-unlocked while this run was working).',
        );
      }
    },
  };
}

/**
 * Drop a lock a crashed run left behind. Prints what it removed, or that there
 * was nothing.
 *
 * The delete names the `runId` this call just read, so an operator who reads a
 * stale lock, decides it is dead, and runs this a moment after the real holder
 * finished and a third run took the lock, drops nothing — the condition fails
 * and the new run keeps its lock. Without it, `--force-unlock` is a delete of
 * whatever happens to be there when it lands.
 */
export async function forceUnlock(
  client: DynamoDBClient,
  tableName: string,
  lockPk: string = RUN_LOCK_PK,
): Promise<void> {
  const holder = await readLock(client, tableName, lockPk);
  if (!holder) {
    console.log('No run lock held.');
    return;
  }

  const runId = text(holder.runId);
  try {
    await client.send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: lockKey(lockPk),
        ...(runId
          ? {
              ConditionExpression: '#runId = :runId',
              ExpressionAttributeNames: { '#runId': 'runId' },
              ExpressionAttributeValues: { ':runId': { S: runId } },
            }
          : {}),
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    console.log('The lock changed hands while this was reading it — nothing was released.');
    return;
  }
  console.log(`Released the run lock held by ${describeHolder(holder)}.`);
}

async function readLock(
  client: DynamoDBClient,
  tableName: string,
  lockPk: string,
): Promise<Partial<LockRow> | undefined> {
  const { Item } = await client.send(
    new GetItemCommand({ TableName: tableName, Key: lockKey(lockPk), ConsistentRead: true }),
  );
  return Item ? decodeRow<LockRow>(Item) : undefined;
}

async function reportHolder(
  client: DynamoDBClient,
  tableName: string,
  lockPk: string,
): Promise<void> {
  const holder = await readLock(client, tableName, lockPk);
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
