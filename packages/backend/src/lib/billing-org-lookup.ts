import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';

/**
 * The org behind a Stripe customer, read off its billing record.
 *
 * Stripe callbacks carry `metadata.userId` but not always an org, and tenant
 * status changes need one. Eventually consistent: the row predates the callback.
 */
export async function resolveOrgIdFromSubscription(userId: string): Promise<string | undefined> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.BillingTable.name,
      Key: { pk: { S: `CUSTOMER#${userId}` }, sk: { S: 'SUBSCRIPTION' } },
      ProjectionExpression: 'orgId',
    }),
  );
  return Item?.orgId?.S;
}
