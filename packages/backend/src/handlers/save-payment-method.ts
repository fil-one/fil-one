import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { SavePaymentMethodResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { getStripeClient } from '../lib/stripe-client.js';
import { resolveSetupIntentPaymentMethod } from '../lib/billing-activation.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

const dynamo = getDynamoClient();

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { userId } = getUserInfo(event);
  const stripe = getStripeClient();
  const tableName = Resource.BillingTable.name;

  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
    }),
  );

  const record = result.Item ? unmarshall(result.Item) : undefined;
  const stripeCustomerId = record?.stripeCustomerId as string | undefined;

  if (!record || !stripeCustomerId) {
    return new ResponseBuilder()
      .status(400)
      .body({ message: 'No Stripe customer found. Please set up a payment method first.' })
      .build();
  }

  const paymentMethodId = await resolveSetupIntentPaymentMethod(stripe, stripeCustomerId);
  if (typeof paymentMethodId !== 'string') {
    return paymentMethodId;
  }

  // Set as the customer's default invoice payment method. The customer.updated
  // webhook will fire and idempotently sync the same fields we write below.
  await stripe.customers.update(stripeCustomerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  if (!pm.card) {
    return new ResponseBuilder()
      .status(400)
      .body({ message: 'Saved payment method is not a card.' })
      .build();
  }

  // Persist directly to DDB to avoid the race where getBilling re-fetches
  // before the customer.updated webhook has run.
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression:
        'SET paymentMethodId = :pmId, paymentMethodLast4 = :last4, paymentMethodBrand = :brand, paymentMethodExpMonth = :expMonth, paymentMethodExpYear = :expYear, updatedAt = :now',
      ExpressionAttributeValues: {
        ':pmId': { S: paymentMethodId },
        ':last4': { S: pm.card.last4 },
        ':brand': { S: pm.card.brand },
        ':expMonth': { N: String(pm.card.exp_month) },
        ':expYear': { N: String(pm.card.exp_year) },
        ':now': { S: new Date().toISOString() },
      },
    }),
  );

  const response: SavePaymentMethodResponse = {
    paymentMethod: {
      id: paymentMethodId,
      last4: pm.card.last4,
      brand: pm.card.brand,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
    },
  };

  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
