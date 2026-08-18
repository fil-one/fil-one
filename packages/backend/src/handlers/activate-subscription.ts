import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  ActivateSubscriptionRequestSchema,
  ApiErrorCode,
  PlanId,
  SubscriptionStatus,
  mapStripeStatus,
} from '@filone/shared';
import type { ActivateSubscriptionResponse } from '@filone/shared';
import { getStripeClient, getBillingSecrets } from '../lib/stripe-client.js';
import { readSubscription } from '../lib/subscription-store.js';
import type { SubscriptionRecord } from '../lib/dynamo-records.js';
import { saveBillingRecord, unlockAllProvisionedRegions } from '../lib/billing-activation.js';
import { isOrgDeleting } from '../lib/org-profile.js';
import { accountDeletedResponse, ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

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

  // Before any Stripe call: a subscription created here is billable and is not
  // in the teardown snapshot, so nothing would cancel it.
  if (await isOrgDeleting(orgId, { consistent: true })) return accountDeletedResponse();

  // 2. Get the org's billing record — the caller's own is only the fallback,
  // so activating billing acts on the org's Stripe customer, not a second one.
  const record = (await readSubscription(orgId, userId))?.record;
  const stripeCustomerId = record?.stripeCustomerId;

  if (!record) {
    return new ResponseBuilder()
      .status(400)
      .body({ message: 'No billing record found. Please set up a payment method first.' })
      .build();
  }

  if (!stripeCustomerId) {
    return new ResponseBuilder()
      .status(400)
      .body({
        message: 'No Stripe customer found. Please set up a payment method first.',
      })
      .build();
  }

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
    orgId,
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

  // 6. Persist billing record and unlock the tenant on every orchestrator
  await saveBillingRecord({ orgId, userId }, subscription, paymentMethodId, mappedStatus);
  await unlockAllProvisionedRegions(orgId);

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

interface CreateOrUpdateSubscriptionParams {
  stripe: ReturnType<typeof getStripeClient>;
  record: SubscriptionRecord;
  paymentMethodId: string;
  secrets: ReturnType<typeof getBillingSecrets>;
  userId: string;
  orgId: string;
  promotionCodeId?: string;
}

async function createOrUpdateSubscription({
  stripe,
  record,
  paymentMethodId,
  secrets,
  userId,
  orgId,
  promotionCodeId,
}: CreateOrUpdateSubscriptionParams) {
  // Canceled subscriptions are terminal in Stripe and cannot be updated; reactivation
  // must create a fresh subscription even though the stale subscriptionId still sits in DDB.
  const isCanceled =
    record.subscriptionStatus === SubscriptionStatus.GracePeriod ||
    record.subscriptionStatus === SubscriptionStatus.Canceled;

  const discounts = promotionCodeId ? [{ promotion_code: promotionCodeId }] : undefined;

  if (record.subscriptionId && !isCanceled) {
    const { subscriptionId } = record;
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
  // The metadata is what every webhook writer resolves the org from. A
  // subscription created without it arrives at the webhook naming no org, and
  // that subscription's whole lifecycle — status changes, payment failures,
  // cancellation — falls back to a billing-row lookup or, once the re-key
  // finishes, to nothing at all.
  return stripe.subscriptions.create({
    customer: record.stripeCustomerId!,
    items: [{ price: secrets.STRIPE_PRICE_ID }],
    default_payment_method: paymentMethodId,
    metadata: { userId, orgId },
    ...(discounts ? { discounts } : {}),
    expand: ['latest_invoice.payment_intent', 'default_payment_method'],
  });
}

function resolveSavedPaymentMethod(record: SubscriptionRecord): PaymentMethodResolution {
  const { subscriptionStatus, paymentMethodId } = record;

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
  .use(authorize('billing.manage'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
