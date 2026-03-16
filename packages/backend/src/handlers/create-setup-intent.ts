import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { SubscriptionStatus } from '@filone/shared';
import type { CreateSetupIntentResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { getStripeClient } from '../lib/stripe-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

const dynamo = getDynamoClient();

async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { userId, email, orgId } = getUserInfo(event);
  const tableName = Resource.BillingTable.name;
  const stripe = getStripeClient();

  // 1. Check if customer already exists in billing table
  const existing = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
    }),
  );

  let stripeCustomerId: string;

  if (existing.Item) {
    const record = unmarshall(existing.Item);
    if (record.stripeCustomerId) {
      stripeCustomerId = record.stripeCustomerId as string;
    } else {
      // Create Stripe customer and update record
      const customer = await stripe.customers.create({
        email: email ?? undefined,
        metadata: { userId },
      });
      stripeCustomerId = customer.id;

      await dynamo.send(
        new PutItemCommand({
          TableName: tableName,
          Item: marshall(
            {
              pk: `CUSTOMER#${userId}`,
              sk: 'SUBSCRIPTION',
              stripeCustomerId,
              orgId,
              subscriptionStatus: SubscriptionStatus.Trialing,
              trialStartedAt: record.trialStartedAt ?? new Date().toISOString(),
              trialEndsAt:
                record.trialEndsAt ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
              updatedAt: new Date().toISOString(),
            },
            { removeUndefinedValues: true },
          ),
        }),
      );
    }
  } else {
    // First time — create Stripe customer and billing record
    const customer = await stripe.customers.create({
      email: email ?? undefined,
      metadata: { userId },
    });
    stripeCustomerId = customer.id;

    await dynamo.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          pk: `CUSTOMER#${userId}`,
          sk: 'SUBSCRIPTION',
          stripeCustomerId,
          orgId,
          subscriptionStatus: SubscriptionStatus.Trialing,
          trialStartedAt: new Date().toISOString(),
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      }),
    );
  }

  // 2. Create SetupIntent
  const setupIntent = await stripe.setupIntents.create({
    customer: stripeCustomerId,
    usage: 'off_session',
  });

  const response: CreateSetupIntentResponse = {
    clientSecret: setupIntent.client_secret!,
  };

  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
