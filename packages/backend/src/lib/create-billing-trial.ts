import {
  ConditionalCheckFailedException,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
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

/**
 * Provision (or heal) the user's billing trial. Returns the subscription status
 * now on the record: the existing status when already provisioned, Trialing when
 * this call created/healed the trial, or the concurrent winner's status when
 * another writer provisioned the record first.
 */
export async function createBillingTrial({
  userId,
  orgId,
  email,
}: CreateBillingTrialParams): Promise<SubscriptionStatus> {
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
  // Already provisioned (trial or paid) — report the actual status so callers
  // never assume Trialing on a record another flow may have set to Active.
  const existingStatus = existing.Item?.subscriptionStatus?.S;
  if (existingStatus) return existingStatus as SubscriptionStatus;
  // Reuse the Stripe customer from an existing record so we never orphan a
  // duplicate customer in Stripe when healing.
  const existingCustomerId = existing.Item?.stripeCustomerId?.S;

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

  // 3. Persist the trial with a single upsert UpdateItem: it creates the record
  // for a fresh signup and fills in the trial fields on an existing status-less
  // record — backfilling stripeCustomerId/orgId with if_not_exists so a bare
  // record becomes canonical without clobbering. Guarded on the status still
  // being absent so a concurrent writer that wins the race trips the condition;
  // ALL_OLD carries the winner's item so we can report its status without
  // another read. (FIL-546)
  try {
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
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Already provisioned by a concurrent writer — no-op, report its status.
      const winnerStatus = err.Item?.subscriptionStatus?.S;
      return (winnerStatus as SubscriptionStatus | undefined) ?? SubscriptionStatus.Trialing;
    }
    throw err;
  }
  return SubscriptionStatus.Trialing;
}
