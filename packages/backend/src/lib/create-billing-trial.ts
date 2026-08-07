import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { isIdentityTombstoned } from './identity-tombstone.js';
import { getStripeClient, getBillingSecrets } from './stripe-client.js';
import type { UserInfo } from './user-context.js';
import { TRIAL_DURATION_DAYS } from '@filone/shared/src/constants.js';

export interface CreateBillingTrialParams {
  userId: string;
  orgId: string;
  email?: string;
  /** Identity this trial belongs to, for the FIL-112 tombstone verification. */
  userInfo: Pick<UserInfo, 'sub'>;
}

export async function createBillingTrial({
  userId,
  orgId,
  email,
  userInfo,
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

  const billingKey = { pk: { S: `CUSTOMER#${userId}` }, sk: { S: 'SUBSCRIPTION' } };

  // 1. Create the billing record BEFORE any Stripe call. The trial window above
  // is computed locally, so this is already a complete, valid trialing record —
  // Stripe only fills in pointers afterwards. Writing it first is what lets the
  // deletion-guarded webhook writers (attribute_exists(pk), lib/deletion-guard.ts)
  // find a record to update instead of silently dropping their writes during the
  // two Stripe round-trips.
  try {
    await getDynamoClient().send(
      new PutItemCommand({
        TableName: Resource.BillingTable.name,
        Item: {
          ...billingKey,
          orgId: { S: orgId },
          subscriptionStatus: { S: SubscriptionStatus.Trialing },
          trialStartedAt: { S: now.toISOString() },
          trialEndsAt: { S: trialEndsAt.toISOString() },
          updatedAt: { S: now.toISOString() },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    // A record appeared between the consistent GetItem above and this Put
    // (concurrent onboarding, or the setup-intent handler). Same outcome as the
    // early return: someone else owns the record, so we must not mint a second
    // Stripe customer/subscription for this user.
    console.info('[create-billing-trial] Billing record created concurrently — skipping trial', {
      userId,
      orgId,
    });
    return;
  }

  // 2. Verify the identity survived the write. The deletion confirm arms the
  // SUB# tombstone strictly before it purges billing, so a tombstone visible
  // *after* our Put proves the purge either already ran (our row is a
  // resurrection) or is about to run against a row it may not see. Compensate.
  if (await isIdentityTombstoned(userInfo)) {
    // Unconditional delete is correct here: the row belongs to a tombstoned
    // identity and teardown deletes this exact key anyway, so there is nothing
    // to preserve. Stripe cleanup never depends on this row either — teardown
    // discovers customers through Stripe metadata, not the billing table.
    await getDynamoClient().send(
      new DeleteItemCommand({ TableName: Resource.BillingTable.name, Key: billingKey }),
    );
    console.warn('identity tombstoned mid-onboarding — early trial row compensated', {
      userId,
      orgId,
    });
    return;
  }

  const stripe = getStripeClient();
  const secrets = getBillingSecrets();

  // 3. Create Stripe customer
  const stripeCustomer = await stripe.customers.create(
    {
      email: email ?? undefined,
      metadata: { userId, orgId },
    },
    { idempotencyKey: `billing-trial-${userId}` },
  );

  // 4. Create Stripe trial subscription
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

  // 5. Fill in the Stripe pointers. The record already exists (step 1), so this
  // is a pure fill-in — the deletion-guarded webhook writers
  // (attribute_exists(pk), see lib/deletion-guard.ts) can no longer drop their
  // writes for lack of a record while the two Stripe calls above are in flight.
  // subscriptionStatus stays behind if_not_exists so a status a webhook has
  // already advanced (e.g. to active) is never regressed to this
  // stale-at-write-time `trialing`.
  //
  // Deliberately NOT deletion-guarded: a write landing mid- or post-deletion is
  // reconciled by the deletion orchestrator's resurrection sweep. Blocking it
  // here would instead lose the customer/subscription mapping at the writer,
  // orphaning a live Stripe subscription with nothing pointing at it.
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
