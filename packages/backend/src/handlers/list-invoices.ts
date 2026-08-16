import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ListInvoicesResponse, Invoice } from '@filone/shared';
import { getStripeClient } from '../lib/stripe-client.js';
import { readSubscription } from '../lib/subscription-store.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { userId, orgId } = getUserInfo(event);

  // Invoices belong to the org's Stripe customer, so an Admin reading them
  // reads the org's, not a record of their own that may not exist.
  const billingRecord = (await readSubscription(orgId, userId))?.record;

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
  .use(authorize('billing.view'))
  .use(errorHandlerMiddleware());
