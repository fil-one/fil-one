import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ListInvoicesResponse, Invoice } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { getStripeClient } from '../lib/stripe-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';
import type { SubscriptionRecord } from '../lib/dynamo-records.js';

const dynamo = getDynamoClient();

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId } = getUserInfo(event);
  const billingTableName = Resource.BillingTable.name;

  const billingResult = await dynamo.send(
    new GetItemCommand({
      TableName: billingTableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
    }),
  );

  const billingRecord = billingResult.Item
    ? (unmarshall(billingResult.Item) as SubscriptionRecord)
    : null;

  if (!billingRecord?.stripeCustomerId) {
    const response: ListInvoicesResponse = { invoices: [] };
    return new ResponseBuilder().status(200).body(response).build();
  }

  const stripe = getStripeClient();
  const stripeInvoices = await stripe.invoices.list({
    customer: billingRecord.stripeCustomerId,
    limit: 3,
    status: 'paid',
  });

  const invoices: Invoice[] = stripeInvoices.data.map((inv) => ({
    id: inv.id,
    amountDueInCents: inv.amount_due,
    status: inv.status ?? 'unknown',
    createdAt: new Date(inv.created * 1000).toISOString(),
    invoicePdfUrl: inv.invoice_pdf ?? null,
  }));

  const response: ListInvoicesResponse = { invoices };
  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(errorHandlerMiddleware());
