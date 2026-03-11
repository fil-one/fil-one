import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { PlanId, SubscriptionStatus } from '@filone/shared';
import type { ActivateSubscriptionResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getStripeClient, getBillingSecrets } from '../lib/stripe-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

const dynamo = new DynamoDBClient({});

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { userId } = getUserInfo(event);
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

  const paymentMethodId =
    typeof latestSetupIntent.payment_method === 'string'
      ? latestSetupIntent.payment_method
      : latestSetupIntent.payment_method?.id;

  if (!paymentMethodId) {
    return new ResponseBuilder()
      .status(400)
      .body({ message: 'Payment method not found on setup intent.' })
      .build();
  }

  // 3. Create subscription
  const subscription = await stripe.subscriptions.create({
    customer: stripeCustomerId,
    items: [{ price: secrets.STRIPE_PRICE_ID }],
    default_payment_method: paymentMethodId,
    expand: ['latest_invoice.payment_intent', 'default_payment_method'],
  });

  // 4. Get payment method details
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

  // 5. Update billing table
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
        ':status': { S: subscription.status },
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

  const response: ActivateSubscriptionResponse = {
    subscription: {
      planId: PlanId.PayAsYouGo,
      status:
        subscription.status === 'active' ? SubscriptionStatus.Active : SubscriptionStatus.Trialing,
      currentPeriodEnd: new Date(
        subscription.items.data[0].current_period_end * 1000,
      ).toISOString(),
    },
  };

  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
