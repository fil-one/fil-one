import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  ActivateSubscriptionRequestSchema,
  PlanId,
  SubscriptionStatus,
  mapStripeStatus,
} from '@filone/shared';
import type { ActivateSubscriptionResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { getStripeClient, getBillingSecrets } from '../lib/stripe-client.js';
import { saveBillingRecord, unlockAuroraTenant } from '../lib/billing-activation.js';
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
  const tableName = Resource.BillingTable.name;
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
  const { useSavedPaymentMethod } = parsed.data;

  // 2. Get customer record from billing table
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
    }),
  );

  if (!result.Item) {
    return new ResponseBuilder()
      .status(400)
      .body({ message: 'No billing record found. Please set up a payment method first.' })
      .build();
  }

  const record = unmarshall(result.Item);
  const stripeCustomerId = record.stripeCustomerId as string;

  if (!stripeCustomerId) {
    return new ResponseBuilder()
      .status(400)
      .body({ message: 'No Stripe customer found. Please set up a payment method first.' })
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

  // 3. Create or update subscription
  const subscription = await createOrUpdateSubscription(
    stripe,
    record,
    paymentMethodId,
    secrets,
    userId,
  );

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

  // 4. Persist billing record and unlock Aurora tenant
  await saveBillingRecord(tableName, userId, subscription, paymentMethodId, mappedStatus);
  await unlockAuroraTenant(orgId);

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

async function createOrUpdateSubscription(
  stripe: ReturnType<typeof getStripeClient>,
  record: Record<string, unknown>,
  paymentMethodId: string,
  secrets: ReturnType<typeof getBillingSecrets>,
  userId: string,
) {
  // Canceled subscriptions are terminal in Stripe and cannot be updated; reactivation
  // must create a fresh subscription even though the stale subscriptionId still sits in DDB.
  const isCanceled =
    record.subscriptionStatus === SubscriptionStatus.GracePeriod ||
    record.subscriptionStatus === SubscriptionStatus.Canceled;

  if (record.subscriptionId && !isCanceled) {
    // Step 1: Attach payment method first
    await stripe.subscriptions.update(record.subscriptionId as string, {
      default_payment_method: paymentMethodId,
    });
    // Step 2: End trial — payment method already attached, so cancel behavior won't fire
    return stripe.subscriptions.update(record.subscriptionId as string, {
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
    expand: ['latest_invoice.payment_intent', 'default_payment_method'],
  });
}

function resolveSavedPaymentMethod(record: Record<string, unknown>): PaymentMethodResolution {
  const subscriptionStatus = record.subscriptionStatus as SubscriptionStatus | undefined;
  const paymentMethodId = record.paymentMethodId as string | undefined;

  const isReactivatable =
    subscriptionStatus === SubscriptionStatus.GracePeriod ||
    subscriptionStatus === SubscriptionStatus.Canceled;

  if (!isReactivatable) {
    return new ResponseBuilder()
      .status(400)
      .body({
        message:
          'Subscription is not eligible for reactivation. Only canceled or grace-period subscriptions can be reactivated this way.',
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
