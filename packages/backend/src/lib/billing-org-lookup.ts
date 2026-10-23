import type Stripe from 'stripe';

/**
 * The org a Stripe object belongs to, from the metadata it carries.
 *
 * Stripe has carried `metadata.orgId` on customers and subscriptions since
 * March, and the webhook backfills it onto any billing row that lacks one — so
 * the Stripe object is the answer.
 */
export function orgIdFromStripeMetadata(
  metadata: Stripe.Metadata | null | undefined,
): string | undefined {
  const orgId = metadata?.orgId;
  return typeof orgId === 'string' && orgId.length > 0 ? orgId : undefined;
}

/**
 * The org a Stripe event is about, from the objects it carries, in the order
 * given. Metadata alone: the billing row is keyed by org now, so there is no
 * row to look an org up FROM without already having the answer. An event whose
 * objects name no org cannot be written — `updateSubscriptionByUser` throws,
 * the Stripe event worker fails the delivery, and the event lands in the DLQ to
 * be redriven once somebody repairs the metadata.
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
