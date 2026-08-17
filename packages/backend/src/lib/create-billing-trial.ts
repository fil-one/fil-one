import { SubscriptionStatus } from '@filone/shared';
import { isOrgDeleting, OrgDeletingError } from './org-profile.js';
import { getStripeClient, getBillingSecrets } from './stripe-client.js';
import { readSubscription, updateSubscription } from './subscription-store.js';
import { TRIAL_DURATION_DAYS } from '@filone/shared/src/constants.js';

export interface CreateBillingTrialParams {
  userId: string;
  orgId: string;
  email?: string;
}

/**
 * The Stripe idempotency keys are keyed to the org, not the human.
 *
 * One person can own two orgs, and a key naming only the user would hand the
 * second org the first org's customer and subscription — one Stripe meter
 * billing two orgs' usage, with no way to tell them apart after the fact. The
 * existence check is keyed the same way, so the check and the keys agree on
 * what "already has a trial" means.
 */
const trialIdempotencyKeys = (orgId: string) => ({
  customer: `billing-trial-org-${orgId}`,
  subscription: `billing-trial-sub-org-${orgId}`,
});

export async function createBillingTrial({
  userId,
  orgId,
  email,
}: CreateBillingTrialParams): Promise<void> {
  // Whether this org already has a subscription — not merely a row. A row with
  // neither a status nor a subscription id is the customer mapping
  // `create-setup-intent` writes when somebody opens the payment modal and
  // closes it, and returning here would forfeit the trial for good over an
  // abandoned card form. The trial is written onto that row instead, and its
  // Stripe customer is reused rather than a second one created for the same org
  // (two customers for one org is two meters billing the same usage).
  const existing = await readSubscription(orgId, {
    consistentRead: true,
    projectionExpression: 'subscriptionStatus, subscriptionId, stripeCustomerId',
  });
  if (existing?.subscriptionStatus || existing?.subscriptionId) return;
  const existingCustomerId = existing?.stripeCustomerId;

  // Checked here rather than at the write below, which is deliberately
  // unconditional (see step 3) and would therefore recreate a purged billing
  // row. It also mints a Stripe customer that teardown's snapshot cannot know
  // about, so nothing would ever cancel or delete it.
  if (await isOrgDeleting(orgId, { consistent: true })) throw new OrgDeletingError(orgId);

  const now = new Date();
  const trialDurationMs = TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000;
  const trialEndsAt = new Date(now.getTime() + trialDurationMs);
  const trialEndsAtUnix = Math.floor(trialEndsAt.getTime() / 1000);

  const stripe = getStripeClient();
  const secrets = getBillingSecrets();
  const idempotency = trialIdempotencyKeys(orgId);

  // 1. The org's Stripe customer: the one already on the record, or a new one.
  // Reusing it also covers the narrow deploy-window case where an earlier
  // user-keyed idempotency key created a customer this org-keyed one cannot see.
  const stripeCustomerId =
    existingCustomerId ??
    (
      await stripe.customers.create(
        {
          email: email ?? undefined,
          metadata: { userId, orgId },
        },
        { idempotencyKey: idempotency.customer },
      )
    ).id;

  // 2. Create Stripe trial subscription
  const subscription = await stripe.subscriptions.create(
    {
      customer: stripeCustomerId,
      items: [{ price: secrets.STRIPE_PRICE_ID }],
      trial_end: trialEndsAtUnix,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      metadata: { userId, orgId },
    },
    { idempotencyKey: idempotency.subscription },
  );

  // 3. Write to DynamoDB, on both keys. Deliberately an unconditional update,
  // NOT a conditional put: Stripe fires customer.subscription.created as soon
  // as the subscription above exists, and if that webhook lands first it
  // upserts a partial record (subscriptionId + status, no customer mapping). A
  // put guarded by attribute_not_exists would then silently no-op and the
  // stripeCustomerId would never be stored — the user could not activate. The
  // update fills the mapping in either arrival order; subscriptionStatus uses
  // if_not_exists so a status a webhook already wrote is never clobbered by
  // this stale-at-write-time `trialing`. That guarantee is per row, and only the
  // legacy row is one a webhook can have written first: the webhook's own writes
  // never create the org twin, so on the org key `if_not_exists` is reading an
  // attribute that is not there yet and this `trialing` always wins.
  //
  // This is the writer that brings the record into existence (`createsRow`), so
  // it writes the whole record — the org and user attributes included, which is
  // what every lifecycle job reads now that the pk names only the org.
  await updateSubscription(
    { orgId, userId },
    {
      createsRow: true,
      UpdateExpression:
        'SET orgId = :orgId, userId = :userId, stripeCustomerId = :customerId, ' +
        'subscriptionId = :subscriptionId, ' +
        'subscriptionStatus = if_not_exists(subscriptionStatus, :status), ' +
        'trialStartedAt = :trialStartedAt, trialEndsAt = :trialEndsAt, ' +
        'currentPeriodStart = :periodStart, currentPeriodEnd = :periodEnd, updatedAt = :now',
      ExpressionAttributeValues: {
        ':orgId': { S: orgId },
        ':userId': { S: userId },
        ':customerId': { S: stripeCustomerId },
        ':subscriptionId': { S: subscription.id },
        ':status': { S: SubscriptionStatus.Trialing },
        ':trialStartedAt': { S: now.toISOString() },
        ':trialEndsAt': { S: trialEndsAt.toISOString() },
        ':periodStart': {
          S: new Date(subscription.items.data[0].current_period_start * 1000).toISOString(),
        },
        ':periodEnd': {
          S: new Date(subscription.items.data[0].current_period_end * 1000).toISOString(),
        },
        ':now': { S: now.toISOString() },
      },
    },
  );
}
