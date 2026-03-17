import { ConditionalCheckFailedException, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { getStripeClient, getBillingSecrets } from './stripe-client.js';

export interface CreateBillingTrialParams {
  userId: string;
  orgId: string;
  email?: string;
}

const TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export async function createBillingTrial({
  userId,
  orgId,
  email,
}: CreateBillingTrialParams): Promise<void> {
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + TRIAL_DURATION_MS);
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

  // 3. Write to DynamoDB (idempotent — skips if record already exists)
  try {
    await getDynamoClient().send(
      new PutItemCommand({
        TableName: Resource.BillingTable.name,
        Item: marshall({
          pk: `CUSTOMER#${userId}`,
          sk: 'SUBSCRIPTION',
          orgId,
          stripeCustomerId: stripeCustomer.id,
          subscriptionId: subscription.id,
          subscriptionStatus: SubscriptionStatus.Trialing,
          trialStartedAt: now.toISOString(),
          trialEndsAt: trialEndsAt.toISOString(),
          currentPeriodStart: new Date(
            subscription.items.data[0].current_period_start * 1000,
          ).toISOString(),
          currentPeriodEnd: new Date(
            subscription.items.data[0].current_period_end * 1000,
          ).toISOString(),
          updatedAt: now.toISOString(),
        }),
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return; // Already exists — no-op
    throw err;
  }
}
