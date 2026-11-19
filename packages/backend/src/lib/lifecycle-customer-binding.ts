import { createHash, randomUUID } from 'node:crypto';
import { GetItemCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.ts';

const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

export function hashLifecycleCustomer(customerId: string): string {
  if (!TOKEN.test(customerId) || !customerId.startsWith('cus_') || customerId.length <= 4) {
    throw new Error('Invalid lifecycle customer reference');
  }
  return createHash('sha256')
    .update(JSON.stringify(['filone-customer-binding-v1', customerId]))
    .digest('hex');
}

/** Bind the current authenticated server-owned Customer before creating a SetupIntent. */
export async function recordLifecycleCustomerBinding({
  orgId,
  customerId,
}: {
  orgId: string;
  customerId: string;
}): Promise<void> {
  const table = process.env.FILONE_LIFECYCLE_CUSTOMER_BINDINGS_TABLE;
  if (!table) return;
  if (!TOKEN.test(orgId)) throw new Error('Invalid lifecycle Organization reference');
  const hash = hashLifecycleCustomer(customerId);
  const now = Math.floor(Date.now() / 1000);
  try {
    await getDynamoClient().send(
      new TransactWriteItemsCommand({
        ClientRequestToken: randomUUID(),
        TransactItems: [
          {
            ConditionCheck: {
              TableName: Resource.BillingTable.name,
              Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'SUBSCRIPTION' } },
              ConditionExpression:
                'attribute_exists(pk) AND stripeCustomerId = :customer AND attribute_not_exists(deletedAt)',
              ExpressionAttributeValues: { ':customer': { S: customerId } },
            },
          },
          {
            ConditionCheck: {
              TableName: Resource.UserInfoTable.name,
              Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
              ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleting)',
            },
          },
          {
            Update: {
              TableName: table,
              Key: { customer_hash: { S: hash } },
              UpdateExpression:
                'SET #org = if_not_exists(#org, :org), #bound = if_not_exists(#bound, :now), #expires = :expires',
              ConditionExpression: 'attribute_not_exists(customer_hash) OR #org = :org',
              ExpressionAttributeNames: {
                '#org': 'organization_id',
                '#bound': 'bound_at_epoch',
                '#expires': 'expires_at',
              },
              ExpressionAttributeValues: {
                ':org': { S: orgId },
                ':now': { N: String(now) },
                ':expires': { N: String(now + 180 * 86400) },
              },
            },
          },
        ],
      }),
    );
  } catch {
    throw new Error('Lifecycle customer binding unavailable');
  }
}

export type AttachmentBinding =
  | { status: 'bound'; organizationId: string }
  | { status: 'unbound' | 'expired' | 'predates-binding' | 'disabled' };

/** Resolve only the durable binding that existed by the original event's occurrence. */
export async function readLifecycleCustomerBinding(
  customerId: string,
  eventCreated: number,
): Promise<AttachmentBinding> {
  const table = process.env.FILONE_LIFECYCLE_CUSTOMER_BINDINGS_TABLE;
  if (!table) return { status: 'disabled' };
  if (!Number.isSafeInteger(eventCreated) || eventCreated <= 0) {
    throw new Error('Invalid lifecycle attachment occurrence');
  }
  const hash = hashLifecycleCustomer(customerId);
  let item;
  try {
    item = (
      await getDynamoClient().send(
        new GetItemCommand({
          TableName: table,
          Key: { customer_hash: { S: hash } },
          ConsistentRead: true,
          ProjectionExpression: 'customer_hash, organization_id, bound_at_epoch, expires_at',
        }),
      )
    ).Item;
  } catch {
    throw new Error('Lifecycle customer binding read unavailable');
  }
  if (!item) return { status: 'unbound' };
  const orgId = item.organization_id?.S;
  const bound = Number(item.bound_at_epoch?.N);
  const expires = Number(item.expires_at?.N);
  if (
    item.customer_hash?.S !== hash ||
    !orgId ||
    !TOKEN.test(orgId) ||
    !Number.isSafeInteger(bound) ||
    bound <= 0 ||
    !Number.isSafeInteger(expires)
  ) {
    throw new Error('Lifecycle customer binding is invalid');
  }
  if (expires <= Math.floor(Date.now() / 1000)) return { status: 'expired' };
  if (bound > eventCreated) return { status: 'predates-binding' };
  return { status: 'bound', organizationId: orgId };
}
