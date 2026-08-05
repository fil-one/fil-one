import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
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

  // 3. Write to DynamoDB. This write is what CREATES the billing record:
  // webhook writers are deletion-guarded (attribute_exists(pk), see
  // lib/deletion-guard.ts) and no-op on a missing record, so a
  // customer.subscription.created event racing this write is dropped rather
  // than upserting a partial record. subscriptionStatus still uses
  // if_not_exists as a belt-and-braces guard: should this write ever re-run
  // after a webhook has updated the record (concurrent onboarding retries),
  // the status the webhook wrote is never clobbered by this
  // stale-at-write-time `trialing`.
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
