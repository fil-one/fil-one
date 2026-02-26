import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { CreatePortalSessionResponse } from '@hyperspace/shared';
import { getEnv } from '../lib/env.js';
import { getStripeClient } from '../lib/stripe-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

const dynamo = new DynamoDBClient({});

async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyResultV2> {
  const { sub } = getUserInfo(event);
  const tableName = getEnv('BILLING_TABLE_NAME');
  const websiteUrl = getEnv('WEBSITE_URL');
  const stripe = await getStripeClient();

  // Get customer record
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${sub}` },
        sk: { S: 'SUBSCRIPTION' },
      },
    }),
  );

  if (!result.Item) {
    return new ResponseBuilder()
      .status(400)
      .body({ message: 'No billing record found.' })
      .build();
  }

  const record = unmarshall(result.Item);
  const stripeCustomerId = record.stripeCustomerId as string;

  if (!stripeCustomerId) {
    return new ResponseBuilder()
      .status(400)
      .body({ message: 'No Stripe customer found.' })
      .build();
  }

  // Create Stripe Customer Portal session
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${websiteUrl}/billing?portal_return=true`,
  });

  const response: CreatePortalSessionResponse = { url: session.url };

  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
