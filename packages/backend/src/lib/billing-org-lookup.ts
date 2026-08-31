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
 * The org behind a Stripe customer, read off its legacy billing record.
 *
 * The fallback for customers that predate `metadata.orgId`, and the one read
 * still keyed by user: its callers hold a Stripe customer with no usable org
 * id, so there is no org key to read with. `customer.deleted` and
 * `customer.updated` both take it — the re-key stamped no metadata on Stripe,
 * so nothing but the row answers for that cohort. Dead once the re-key's dated
 * cleanup deletes the legacy rows, by which point the cohort has been
 * dispositioned by name (docs/BillingRekeyRunbook.md).
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

/**
 * The org a Stripe event is about, from the objects it carries, in the order
 * given. Metadata alone: the billing row is keyed by org now, so there is no
 * row to look an org up FROM without already having the answer. An event whose
 * objects name no org cannot be written — `updateSubscriptionByUser` throws,
 * the webhook 500s, and Stripe retries until somebody repairs the metadata.
 */
export function resolveOrgId(
  ...metadata: Array<Stripe.Metadata | null | undefined>
): string | undefined {
  for (const source of metadata) {
    const orgId = orgIdFromStripeMetadata(source);
    if (orgId) return orgId;
  }
  return undefined;
}
