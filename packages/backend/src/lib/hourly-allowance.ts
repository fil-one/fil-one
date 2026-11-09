import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { getDynamoClient } from './ddb-client.ts';

const HOUR_MS = 60 * 60 * 1000;

/** Whether a call fit in the hour's allowance, and if not, when the next one will. */
export type HourlyAllowance = { allowed: true } | { allowed: false; retryAt: Date };

/**
 * Spend one call from the hourly allowance on the row at `key`, or refuse.
 *
 * The row holds one window: `windowStart` (epoch ms) and `count`. A window
 * lasts an hour; the first call after it has passed opens a new one. A refused
 * call spends nothing, and learns when its window closes from the row the last
 * spend was refused against.
 */
export async function takeHourlyAllowance({
  tableName,
  key,
  max,
  now = new Date(),
}: {
  tableName: string;
  key: Record<string, AttributeValue>;
  /** Calls one window allows. */
  max: number;
  now?: Date;
}): Promise<HourlyAllowance> {
  const cutoff = { N: String(now.getTime() - HOUR_MS) };
  const names = { '#count': 'count', '#windowStart': 'windowStart' };
  const spend = (returnRowOnRefusal: boolean) =>
    new UpdateItemCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: 'SET #count = #count + :one',
      ConditionExpression: '#windowStart > :cutoff AND #count < :max',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':cutoff': cutoff,
        ':max': { N: String(max) },
      },
      ...(returnRowOnRefusal && { ReturnValuesOnConditionCheckFailure: 'ALL_OLD' }),
    });
  const openWindow = new UpdateItemCommand({
    TableName: tableName,
    Key: key,
    UpdateExpression: 'SET #windowStart = :now, #count = :one',
    ConditionExpression: 'attribute_not_exists(#windowStart) OR #windowStart <= :cutoff',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: {
      ':now': { N: String(now.getTime()) },
      ':one': { N: '1' },
      ':cutoff': cutoff,
    },
  });

  // The last spend covers a concurrent call that opened the window first.
  const attempts = [spend(false), openWindow, spend(true)];
  let refusedRow: Record<string, AttributeValue> | undefined;
  for (const command of attempts) {
    try {
      await getDynamoClient().send(command);
      return { allowed: true };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      refusedRow = err.Item;
    }
  }
  const windowStart = Number(refusedRow?.windowStart?.N);
  // Without a row to read, the window can at worst have just opened.
  const opened = Number.isFinite(windowStart) ? windowStart : now.getTime();
  return { allowed: false, retryAt: new Date(opened + HOUR_MS) };
}
