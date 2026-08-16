import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import type Stripe from 'stripe';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { SubscriptionKeys } from './subscription-store.js';

/**
 * The org a Stripe object belongs to, from the metadata it carries.
 *
 * Stripe has carried `metadata.orgId` on customers and subscriptions since
 * March, and the webhook backfills it onto any billing row that lacks one — so
 * the Stripe object is the direct answer, and the billing-row read below is
 * the fallback for objects created before the metadata (or by hand in the
 * Stripe dashboard).
 */
export function orgIdFromStripeMetadata(
  metadata: Stripe.Metadata | null | undefined,
): string | undefined {
  const orgId = metadata?.orgId;
  return typeof orgId === 'string' && orgId.length > 0 ? orgId : undefined;
}

/**
 * The org behind a Stripe customer, read off its billing record.
 *
 * Stripe callbacks carry `metadata.userId` but not always an org, and tenant
 * status changes need one. Eventually consistent: the row predates the callback.
 * The one read still keyed by user: the callers hold a Stripe object with no
 * usable org id, so there is no org key to read with.
 */
export async function resolveOrgIdFromSubscription(userId: string): Promise<string | undefined> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.BillingTable.name,
      Key: { pk: { S: SubscriptionKeys.legacyPk(userId) }, sk: { S: SubscriptionKeys.sk() } },
      ProjectionExpression: 'orgId',
    }),
  );
  return Item?.orgId?.S;
}

/** The org for a Stripe object: its own metadata first, the billing row second. */
export async function resolveOrgId(
  userId: string,
  metadata: Stripe.Metadata | null | undefined,
): Promise<string | undefined> {
  return orgIdFromStripeMetadata(metadata) ?? (await resolveOrgIdFromSubscription(userId));
}
