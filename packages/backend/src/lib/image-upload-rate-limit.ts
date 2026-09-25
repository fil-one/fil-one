import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.ts';

/**
 * How many image upload URLs one person may ask for in an hour. Far above anyone
 * choosing a picture (a few tries, a change of mind), and low enough that the
 * public logo bucket is not free hosting for whoever loops the endpoint.
 */
export const IMAGE_UPLOAD_PRESIGNS_PER_HOUR = 30;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Spend one of the caller's image upload URLs for the current hour, or refuse.
 * Images for the console only (the public image buckets): object uploads into
 * a customer's buckets are not counted here.
 *
 * A counter per user per clock hour, incremented only while under the limit,
 * so a refused call spends nothing. The row expires on its own a day later
 * (TTL is cleanup only; the hour in the key is what resets the count).
 *
 * @returns whether the caller may have another image upload URL.
 */
export async function takeImageUploadPresign(userId: string, now = new Date()): Promise<boolean> {
  const hour = Math.floor(now.getTime() / HOUR_MS);
  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: Resource.ImageUploadRateLimitTable.name,
        Key: { pk: { S: `USER#${userId}#HOUR#${hour}` } },
        UpdateExpression: 'ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': { N: '1' },
          ':max': { N: String(IMAGE_UPLOAD_PRESIGNS_PER_HOUR) },
          ':ttl': { N: String(Math.floor(now.getTime() / 1000) + 24 * 60 * 60) },
        },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}
