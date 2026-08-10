import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type Stripe from 'stripe';
import {
  ActivateSubscriptionRequestSchema,
  ApiErrorCode,
  PlanId,
  SubscriptionStatus,
  mapStripeStatus,
} from '@filone/shared';
import type { ActivateSubscriptionResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { getStripeClient, getBillingSecrets } from '../lib/stripe-client.js';
import { saveBillingRecord, unlockAllProvisionedRegions } from '../lib/billing-activation.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

const dynamo = getDynamoClient();

type PaymentMethodResolution = string | APIGatewayProxyResultV2;

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { userId, orgId } = getUserInfo(event);
  const stripe = getStripeClient();
  const secrets = getBillingSecrets();

  // 1. Parse + validate request body
  let parsedJson: unknown = {};
  if (event.body) {
    try {
      parsedJson = JSON.parse(event.body);
    } catch {
      return new ResponseBuilder().status(400).body({ message: 'Invalid JSON body.' }).build();
    }
  }
  const parsed = ActivateSubscriptionRequestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return new ResponseBuilder()
      .status(400)
      .body({ message: 'Invalid request body.', issues: parsed.error.issues })
      .build();
  }
  const { useSavedPaymentMethod, promotionCode } = parsed.data;

  // 2. Get customer record from billing table
  const resolved = await resolveActivatableRecord(userId, orgId);
  if ('error' in resolved) return resolved.error;
  const { record, stripeCustomerId } = resolved;

  // 3. Resolve payment method: saved (DDB) or freshly confirmed (SetupIntent)
  const paymentMethodId = useSavedPaymentMethod
    ? resolveSavedPaymentMethod(record)
    : await resolveSetupIntentPaymentMethod(stripe, stripeCustomerId);

  if (typeof paymentMethodId !== 'string') {
    // Helper returned a ResponseBuilder result on validation failure.
    return paymentMethodId;
  }

  // 4. Resolve promo code against Stripe before we mutate any subscription state.
  let promotionCodeId: string | undefined;
  if (promotionCode) {
    const matches = await stripe.promotionCodes.list({
      code: promotionCode,
      active: true,
      limit: 1,
    });
    promotionCodeId = matches.data[0]?.id;
    if (!promotionCodeId) {
      return new ResponseBuilder()
        .status(400)
        .body({
          message: 'Invalid or expired promo code.',
          code: ApiErrorCode.INVALID_PROMOTION_CODE,
        })
        .build();
    }
  }

  // 5. Create or update subscription
  const subscription = await createOrUpdateSubscription({
    stripe,
    record,
    paymentMethodId,
    secrets,
    userId,
    promotionCodeId,
  });

  // Guard: reject if subscription is not in a usable state after activation.
  // e.g. Stripe returns 'incomplete' when 3DS challenge is required but not completed.
  const mappedStatus = mapStripeStatus(subscription.status);
  if (mappedStatus !== SubscriptionStatus.Active && mappedStatus !== SubscriptionStatus.Trialing) {
    console.error('[activate-subscription] Subscription not active after activation', {
      userId,
      subscriptionId: subscription.id,
      stripeStatus: subscription.status,
    });
    return new ResponseBuilder()
      .status(402)
      .body({
        message:
          'Payment could not be completed for this subscription. Additional authentication may be required. Please verify your payment details and try again.',
      })
      .build();
  }

  // 6. Persist billing record and unlock the tenant on every orchestrator.
  const saveArgs = { userId, orgId, subscription, paymentMethodId, mappedStatus };
  const deletionGuardResponse = await persistBillingAndUnlock(saveArgs);
  if (deletionGuardResponse) return deletionGuardResponse;

  const response: ActivateSubscriptionResponse = {
    subscription: {
      planId: PlanId.PayAsYouGo,
      status: mappedStatus,
      currentPeriodEnd: new Date(
        subscription.items.data[0].current_period_end * 1000,
      ).toISOString(),
    },
  };

  return new ResponseBuilder().status(200).body(response).build();
}

/**
 * Deletion-guarded billing-record save + tenant unlock. The save is guarded against
 * FIL-112 account deletion: when the teardown owns (or has purged) the
 * record, this request must not unlock tenants the teardown is disabling —
 * returns the 410 ACCOUNT_DELETED response instead, or null on success.
 */
async function persistBillingAndUnlock(params: {
  userId: string;
  orgId: string;
  subscription: Stripe.Subscription;
  paymentMethodId: string;
  mappedStatus: SubscriptionStatus;
}): Promise<APIGatewayProxyResultV2 | null> {
  const { userId, orgId, subscription, paymentMethodId, mappedStatus } = params;
  const saved = await saveBillingRecord(userId, subscription, paymentMethodId, mappedStatus);
  if (!saved) {
    console.warn('[activate-subscription] Account deletion in progress; skipping unlock', {
      userId,
      orgId,
    });
    // createOrUpdateSubscription already mutated Stripe before the guard
    // rejected. When the stored status was grace_period/canceled that
    // mutation created a brand-NEW subscription, which the teardown (which
    // cancels only the snapshotted subscriptionId) would never cancel —
    // billing a deleted account forever. Best-effort cancel it here;
    // failures are logged and swallowed so the 410 still reaches the client.
    try {
      await getStripeClient().subscriptions.cancel(subscription.id);
      console.log('[activate-subscription] Canceled subscription activated mid-deletion', {
        userId,
        subscriptionId: subscription.id,
      });
    } catch (error) {
      console.error(
        '[activate-subscription] Failed to cancel subscription after deletion-guard rejection; ' +
          'it may keep billing a deleted account and needs manual cleanup',
        { userId, subscriptionId: subscription.id, error },
      );
    }
    return accountDeletedResponse();
  }
  // Accepted TOCTOU with account deletion (FIL-112): the guarded save above
  // passed on then-current state, but a teardown can claim the record before
  // this unlock lands. The transiently unlocked tenant converges when the
  // teardown deletes the tenants themselves.
  await unlockAllProvisionedRegions(orgId);
  return null;
}

type ActivatableRecord =
  | { record: Record<string, unknown>; stripeCustomerId: string }
  | { error: APIGatewayProxyResultV2 };

/**
 * Loads the billing record and refuses everything that must not reach Stripe.
 *
 * The FIL-112 branch is the load-bearing one: the write-time DELETION_GUARD in
 * `saveBillingRecord` fires only *after* `createOrUpdateSubscription` has set
 * `trial_end: 'now'`, which generates and charges an invoice — and the
 * compensating `subscriptions.cancel` does not refund it, so a customer
 * mid-deletion would be billed and then 410'd. Checking here is defence in
 * depth, not a replacement: the guarded write still owns the genuine race
 * where the teardown lands after this read.
 */
async function resolveActivatableRecord(userId: string, orgId: string): Promise<ActivatableRecord> {
  const record = await getCustomerBillingRecord(userId);
  const stripeCustomerId = record?.stripeCustomerId as string | undefined;

  // Ordered ahead of both 400s: a mid-deletion record can legitimately lack
  // `stripeCustomerId` (webhook-born and legacy records exist — see
  // get-billing.ts), and such an account must be told ACCOUNT_DELETED, not
  // handed the actionable-looking "set up a payment method first".
  if (record?.deletionRequestedAt) {
    console.warn('[activate-subscription] Account deletion in progress; refusing activation', {
      userId,
      orgId,
    });
    return { error: accountDeletedResponse() };
  }

  if (!record) {
    return {
      error: new ResponseBuilder()
        .status(400)
        .body({ message: 'No billing record found. Please set up a payment method first.' })
        .build(),
    };
  }

  if (!stripeCustomerId) {
    return {
      error: new ResponseBuilder()
        .status(400)
        .body({ message: 'No Stripe customer found. Please set up a payment method first.' })
        .build(),
    };
  }

  return { record, stripeCustomerId };
}

/** The single ACCOUNT_DELETED shape this handler returns, pre-check and post-guard alike. */
function accountDeletedResponse(): APIGatewayProxyResultV2 {
  return new ResponseBuilder()
    .status(410)
    .body({ message: 'Account has been deleted', code: ApiErrorCode.ACCOUNT_DELETED })
    .build();
}

async function getCustomerBillingRecord(
  userId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.BillingTable.name,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      // Consistent: `deletionRequestedAt` is written synchronously before the
      // confirm handler returns 200, so an eventually-consistent read inside the
      // replication window (duplicate submit, second tab, client retry) would
      // pass the pre-check below, reach `trial_end: 'now'` — which charges an
      // invoice — and only then be 410'd by the write-time guard, whose
      // compensating cancel does not refund. Same reasoning as the
      // ConsistentRead in middleware/subscription-guard.ts.
      ConsistentRead: true,
    }),
  );

  return result.Item ? unmarshall(result.Item) : undefined;
}

interface CreateOrUpdateSubscriptionParams {
  stripe: ReturnType<typeof getStripeClient>;
  record: Record<string, unknown>;
  paymentMethodId: string;
  secrets: ReturnType<typeof getBillingSecrets>;
  userId: string;
  promotionCodeId?: string;
}

async function createOrUpdateSubscription({
  stripe,
  record,
  paymentMethodId,
  secrets,
  userId,
  promotionCodeId,
}: CreateOrUpdateSubscriptionParams) {
  // Canceled subscriptions are terminal in Stripe and cannot be updated; reactivation
  // must create a fresh subscription even though the stale subscriptionId still sits in DDB.
  const isCanceled =
    record.subscriptionStatus === SubscriptionStatus.GracePeriod ||
    record.subscriptionStatus === SubscriptionStatus.Canceled;

  const discounts = promotionCodeId ? [{ promotion_code: promotionCodeId }] : undefined;

  if (record.subscriptionId && !isCanceled) {
    const subscriptionId = record.subscriptionId as string;
    // Step 1: Attach payment method
    await stripe.subscriptions.update(subscriptionId, {
      default_payment_method: paymentMethodId,
    });
    // Step 2: Persist the discount on its own update so it's in place before the
    // trial-end update generates the first paid invoice. Bundling discounts and
    // trial_end into the same call leaves invoice ordering ambiguous.
    if (promotionCodeId) {
      await stripe.subscriptions.update(subscriptionId, {
        discounts: [{ promotion_code: promotionCodeId }],
      });
    }
    // Step 3: End trial — invoice is generated from the now-discounted subscription.
    return stripe.subscriptions.update(subscriptionId, {
      trial_end: 'now',
      expand: ['latest_invoice.payment_intent', 'default_payment_method'],
    });
  }
  if (!record.subscriptionId) {
    console.warn('[activate-subscription] No existing subscription found for user, creating new', {
      userId,
    });
  }
  return stripe.subscriptions.create({
    customer: record.stripeCustomerId as string,
    items: [{ price: secrets.STRIPE_PRICE_ID }],
    default_payment_method: paymentMethodId,
    ...(discounts ? { discounts } : {}),
    expand: ['latest_invoice.payment_intent', 'default_payment_method'],
  });
}

function resolveSavedPaymentMethod(record: Record<string, unknown>): PaymentMethodResolution {
  const subscriptionStatus = record.subscriptionStatus as SubscriptionStatus | undefined;
  const paymentMethodId = record.paymentMethodId as string | undefined;

  const isCanceled =
    subscriptionStatus === SubscriptionStatus.GracePeriod ||
    subscriptionStatus === SubscriptionStatus.Canceled;

  if (!isCanceled) {
    return new ResponseBuilder()
      .status(400)
      .body({
        message: 'Only canceled or grace-period subscriptions can use a saved payment method.',
      })
      .build();
  }

  if (!paymentMethodId) {
    return new ResponseBuilder()
      .status(400)
      .body({ message: 'No saved payment method. Please add a card.' })
      .build();
  }

  return paymentMethodId;
}

async function resolveSetupIntentPaymentMethod(
  stripe: ReturnType<typeof getStripeClient>,
  stripeCustomerId: string,
): Promise<PaymentMethodResolution> {
  const setupIntents = await stripe.setupIntents.list({
    customer: stripeCustomerId,
    limit: 1,
  });

  const latestSetupIntent = setupIntents.data[0];
  if (!latestSetupIntent || latestSetupIntent.status !== 'succeeded') {
    return new ResponseBuilder()
      .status(400)
      .body({
        message: 'No confirmed payment method found. Please complete the payment setup first.',
      })
      .build();
  }

  const pm = latestSetupIntent.payment_method;
  const paymentMethodId = typeof pm === 'string' ? pm : pm?.id;

  if (!paymentMethodId) {
    return new ResponseBuilder()
      .status(400)
      .body({ message: 'Payment method not found on setup intent.' })
      .build();
  }

  return paymentMethodId;
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
