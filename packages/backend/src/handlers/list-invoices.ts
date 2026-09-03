import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ListInvoicesResponse, Invoice } from '@filone/shared';
import type Stripe from 'stripe';
import { getStripeClient } from '../lib/stripe-client.js';
import { readSubscription } from '../lib/subscription-store.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

/**
 * How many invoices the console lists: a year of monthly billing, in one Stripe
 * call. Older ones are in the customer portal, which the console links to rather
 * than paginating a second copy of Stripe's archive.
 */
const INVOICE_LIMIT = 12;

/**
 * Whether an invoice has been issued to the customer.
 *
 * Everything but a draft. This list was filtered to `paid` invoices, which meant
 * the one invoice a customer most wants to find — the unpaid one their failed
 * payment is about — was the only one the console would not show them. A draft
 * is the genuine exception: Stripe has not finalised it, its amount can still
 * change, and it is not yet a bill.
 */
function isIssued(invoice: Stripe.Invoice): boolean {
  return invoice.status !== 'draft';
}

export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const { orgId } = getUserInfo(event);

  // Invoices belong to the org's Stripe customer, so an Admin reading them
  // reads the org's, not a record of their own that may not exist.
  const billingRecord = await readSubscription(orgId);

  if (!billingRecord?.stripeCustomerId) {
    const response: ListInvoicesResponse = { invoices: [] };
    return new ResponseBuilder().status(200).body(response).build();
  }

  const stripe = getStripeClient();
  const stripeInvoices = await stripe.invoices.list({
    customer: billingRecord.stripeCustomerId,
    limit: INVOICE_LIMIT,
  });

  const invoices: Invoice[] = stripeInvoices.data.filter(isIssued).map((inv) => ({
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
