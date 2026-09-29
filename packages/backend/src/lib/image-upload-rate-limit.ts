import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.ts';

/**
 * How many image upload URLs one limit allows in an hour. Far above anyone
 * choosing a picture (a few tries, a change of mind), and low enough that the
 * public image buckets are not free hosting for whoever loops the endpoint.
 */
export const IMAGE_UPLOAD_PRESIGNS_PER_HOUR = 30;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Spend one URL from the hourly allowance on the row at `key`, or refuse.
 *
 * The row holds one window: `windowStart` (epoch ms) and `count`. A window
 * lasts an hour; the first call after it has passed opens a new one. A refused
 * call spends nothing.
 *
 * @returns whether the caller may have another image upload URL.
 */
export async function takeHourlyAllowance({
  tableName,
  key,
  now = new Date(),
}: {
  tableName: string;
  key: Record<string, AttributeValue>;
  now?: Date;
}): Promise<boolean> {
  const cutoff = { N: String(now.getTime() - HOUR_MS) };
  const names = { '#count': 'count', '#windowStart': 'windowStart' };
  const spend = () =>
    new UpdateItemCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: 'SET #count = #count + :one',
      ConditionExpression: '#windowStart > :cutoff AND #count < :max',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':cutoff': cutoff,
        ':max': { N: String(IMAGE_UPLOAD_PRESIGNS_PER_HOUR) },
      },
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
  for (const command of [spend(), openWindow, spend()]) {
    try {
      await getDynamoClient().send(command);
      return true;
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }
  return false;
}

/** Spend one of the org's logo upload URLs for the hour, or refuse. */
export function takeOrgLogoPresign(orgId: string, now?: Date): Promise<boolean> {
  return takeHourlyAllowance({
    tableName: Resource.OrgTable.name,
    key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'LOGO_UPLOAD_RATE' } },
    now,
  });
}

/** Spend one of the user's avatar upload URLs for the hour, or refuse. */
export function takeAvatarPresign(userId: string, now?: Date): Promise<boolean> {
  return takeHourlyAllowance({
    tableName: Resource.UserInfoTable.name,
    key: { pk: { S: `USER#${userId}` }, sk: { S: 'AVATAR_UPLOAD_RATE' } },
    now,
  });
}
