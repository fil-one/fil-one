import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { isOrgDeleting, OrgDeletingError } from './org-profile.js';
import { getStripeClient, getBillingSecrets } from './stripe-client.js';
import { TRIAL_DURATION_DAYS } from '@filone/shared/src/constants.js';

export interface CreateBillingTrialParams {
  userId: string;
  orgId: string;
  email?: string;
}

export async function createBillingTrial({
  userId,
  orgId,
  email,
}: CreateBillingTrialParams): Promise<void> {
  // Check if this user already has a billing record.
  const existing = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.BillingTable.name,
      Key: { pk: { S: `CUSTOMER#${userId}` }, sk: { S: 'SUBSCRIPTION' } },
      ConsistentRead: true,
      ProjectionExpression: 'pk',
    }),
  );
  if (existing.Item) return;

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

  // 1. Create Stripe customer
  const stripeCustomer = await stripe.customers.create(
    {
      email: email ?? undefined,
      metadata: { userId, orgId },
    },
    { idempotencyKey: `billing-trial-${userId}` },
  );

  // 2. Create Stripe trial subscription
  const subscription = await stripe.subscriptions.create(
    {
      customer: stripeCustomer.id,
      items: [{ price: secrets.STRIPE_PRICE_ID }],
      trial_end: trialEndsAtUnix,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      metadata: { userId, orgId },
    },
    { idempotencyKey: `billing-trial-sub-${userId}` },
  );

  // 3. Write to DynamoDB. Deliberately an unconditional update, NOT a
  // conditional put: Stripe fires customer.subscription.created as soon as the
  // subscription above exists, and if that webhook lands first it upserts a
  // partial record (subscriptionId + status, no customer mapping). A
  // put guarded by attribute_not_exists would then silently no-op and the
  // stripeCustomerId would never be stored — the user could not activate. The
  // update fills the mapping in either arrival order; subscriptionStatus uses
  // if_not_exists so a status a webhook already wrote is never clobbered by
  // this stale-at-write-time `trialing`.
  await getDynamoClient().send(
    new UpdateItemCommand({
      TableName: Resource.BillingTable.name,
      Key: { pk: { S: `CUSTOMER#${userId}` }, sk: { S: 'SUBSCRIPTION' } },
      UpdateExpression:
        'SET orgId = :orgId, stripeCustomerId = :customerId, subscriptionId = :subscriptionId, ' +
        'subscriptionStatus = if_not_exists(subscriptionStatus, :status), ' +
        'trialStartedAt = :trialStartedAt, trialEndsAt = :trialEndsAt, ' +
        'currentPeriodStart = :periodStart, currentPeriodEnd = :periodEnd, updatedAt = :now',
      ExpressionAttributeValues: {
        ':orgId': { S: orgId },
        ':customerId': { S: stripeCustomer.id },
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
    }),
  );
}
