import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
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
  // Project the fields we branch on. A record that already carries a
  // subscriptionStatus is fully provisioned (idempotent no-op). A status-less
  // "bare" record — written by create-setup-intent to remember the Stripe
  // customer before any trial existed — must be HEALED into a full trial record
  // rather than skipped, otherwise the user is permanently blocked (FIL-546).
  const existing = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.BillingTable.name,
      Key: { pk: { S: `CUSTOMER#${userId}` }, sk: { S: 'SUBSCRIPTION' } },
      ConsistentRead: true,
      ProjectionExpression: 'subscriptionStatus, stripeCustomerId',
    }),
  );
  // Already provisioned (trial or paid) — nothing to do.
  if (existing.Item?.subscriptionStatus) return;
  // Reuse the Stripe customer from an existing record so we never orphan a
  // duplicate customer in Stripe when healing.
  const existingCustomerId = existing.Item?.stripeCustomerId?.S;
  // Any existing status-less record must be healed via UpdateItem — a PutItem
  // guarded on attribute_not_exists(pk) would always fail for it and be swallowed,
  // leaving the record unhealed after Stripe side effects already happened. This
  // also covers a record that exists without a stripeCustomerId.
  const recordExists = Boolean(existing.Item);

  const now = new Date();
  const trialDurationMs = TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000;
  const trialEndsAt = new Date(now.getTime() + trialDurationMs);
  const trialEndsAtUnix = Math.floor(trialEndsAt.getTime() / 1000);

  const stripe = getStripeClient();
  const secrets = getBillingSecrets();

  // 1. Reuse the Stripe customer from a bare record if one exists; otherwise
  // create one. Reuse keeps the saved payment method (attached via the
  // create-setup-intent SetupIntent) on the same customer as the subscription.
  const stripeCustomer = existingCustomerId
    ? { id: existingCustomerId }
    : await stripe.customers.create(
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

  const currentPeriodStart = new Date(
    subscription.items.data[0].current_period_start * 1000,
  ).toISOString();
  const currentPeriodEnd = new Date(
    subscription.items.data[0].current_period_end * 1000,
  ).toISOString();

  // 3. Persist the trial. When healing an existing status-less record, fill in the
  // trial fields — and backfill stripeCustomerId/orgId with if_not_exists so the
  // record becomes canonical without clobbering — via an UpdateItem guarded on the
  // status still being absent. Otherwise create the record outright. Both writes are
  // idempotent: a concurrent writer that wins the race trips the condition and we
  // no-op. (FIL-546)
  try {
    if (recordExists) {
      await getDynamoClient().send(
        new UpdateItemCommand({
          TableName: Resource.BillingTable.name,
          Key: { pk: { S: `CUSTOMER#${userId}` }, sk: { S: 'SUBSCRIPTION' } },
          UpdateExpression:
            'SET subscriptionId = :subId, subscriptionStatus = :status, trialStartedAt = :ts, trialEndsAt = :te, currentPeriodStart = :cps, currentPeriodEnd = :cpe, updatedAt = :now, stripeCustomerId = if_not_exists(stripeCustomerId, :cid), orgId = if_not_exists(orgId, :orgId)',
          ConditionExpression: 'attribute_not_exists(subscriptionStatus)',
          ExpressionAttributeValues: {
            ':subId': { S: subscription.id },
            ':status': { S: SubscriptionStatus.Trialing },
            ':ts': { S: now.toISOString() },
            ':te': { S: trialEndsAt.toISOString() },
            ':cps': { S: currentPeriodStart },
            ':cpe': { S: currentPeriodEnd },
            ':now': { S: now.toISOString() },
            ':cid': { S: stripeCustomer.id },
            ':orgId': { S: orgId },
          },
        }),
      );
    } else {
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
            currentPeriodStart,
            currentPeriodEnd,
            updatedAt: now.toISOString(),
          }),
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    }
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return; // Already provisioned — no-op
    throw err;
  }
}
