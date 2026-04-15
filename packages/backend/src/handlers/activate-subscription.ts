import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { PlanId, SubscriptionStatus, mapStripeStatus } from '@filone/shared';
import type { ActivateSubscriptionResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { getStripeClient, getBillingSecrets } from '../lib/stripe-client.js';
import { updateTenantStatus } from '../lib/aurora-backoffice.js';
import { setOrgAuroraTenantStatus } from '../lib/org-profile.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

const dynamo = getDynamoClient();

function resolvePaymentMethodId(
  paymentMethod: string | { id: string } | null | undefined,
): string | undefined {
  if (typeof paymentMethod === 'string') return paymentMethod;
  return paymentMethod?.id;
}

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { userId, orgId } = getUserInfo(event);
  const tableName = Resource.BillingTable.name;
  const stripe = getStripeClient();
  const secrets = getBillingSecrets();

  // 1. Get customer record from billing table
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

  // 2. Retrieve the latest succeeded SetupIntent to get payment_method
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

  const paymentMethodId = resolvePaymentMethodId(latestSetupIntent.payment_method);

  if (!paymentMethodId) {
    return new ResponseBuilder()
      .status(400)
      .body({ message: 'Payment method not found on setup intent.' })
      .build();
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
  if (record.subscriptionId) {
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
  console.warn('[activate-subscription] No existing subscription found for user, creating new', {
    userId,
  });
  return stripe.subscriptions.create({
    customer: record.stripeCustomerId as string,
    items: [{ price: secrets.STRIPE_PRICE_ID }],
    default_payment_method: paymentMethodId,
    expand: ['latest_invoice.payment_intent', 'default_payment_method'],
  });
}

async function saveBillingRecord(
  tableName: string,
  userId: string,
  subscription: Awaited<ReturnType<typeof createOrUpdateSubscription>>,
  paymentMethodId: string,
  mappedStatus: SubscriptionStatus,
) {
  const pm = subscription.default_payment_method;
  let paymentMethodLast4 = '';
  let paymentMethodBrand = '';
  let paymentMethodExpMonth = 0;
  let paymentMethodExpYear = 0;

  if (pm && typeof pm === 'object' && pm.card) {
    paymentMethodLast4 = pm.card.last4;
    paymentMethodBrand = pm.card.brand;
    paymentMethodExpMonth = pm.card.exp_month;
    paymentMethodExpYear = pm.card.exp_year;
  }

  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression:
        'SET subscriptionId = :subId, subscriptionStatus = :status, currentPeriodEnd = :periodEnd, paymentMethodId = :pmId, paymentMethodLast4 = :last4, paymentMethodBrand = :brand, paymentMethodExpMonth = :expMonth, paymentMethodExpYear = :expYear, updatedAt = :now REMOVE trialEndsAt',
      ExpressionAttributeValues: {
        ':subId': { S: subscription.id },
        ':status': { S: mappedStatus },
        ':periodEnd': {
          S: new Date(subscription.items.data[0].current_period_end * 1000).toISOString(),
        },
        ':pmId': { S: paymentMethodId },
        ':last4': { S: paymentMethodLast4 },
        ':brand': { S: paymentMethodBrand },
        ':expMonth': { N: String(paymentMethodExpMonth) },
        ':expYear': { N: String(paymentMethodExpYear) },
        ':now': { S: new Date().toISOString() },
      },
    }),
  );
}

async function unlockAuroraTenant(orgId: string) {
  const { Item: orgProfile } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
      },
    }),
  );
  const auroraTenantId = orgProfile?.auroraTenantId?.S;
  const setupStatus = orgProfile?.setupStatus?.S;
  if (!auroraTenantId || !isOrgSetupComplete(setupStatus)) {
    throw new Error(`Aurora tenant setup is not complete for org ${orgId}`);
  }
  try {
    await updateTenantStatus({ tenantId: auroraTenantId, status: 'ACTIVE' });
    await setOrgAuroraTenantStatus(orgId, 'ACTIVE');
    console.log('[activate-subscription] Aurora tenant unlocked', { orgId, auroraTenantId });
  } catch (error) {
    console.error('[activate-subscription] Failed to unlock Aurora tenant', {
      orgId,
      error: (error as Error).message,
    });
    throw error;
  }
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
