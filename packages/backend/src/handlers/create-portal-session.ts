import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { CreatePortalSessionResponse } from '@filone/shared';
import { getStripeClient } from '../lib/stripe-client.js';
import { resolveOrigin } from '../lib/resolve-origin.js';
import { readSubscription } from '../lib/subscription-store.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

export async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { orgId } = getUserInfo(event);
  // Follows the hostname the user is actually on, so a session started from a
  // demo alias returns there instead of jumping to the canonical host. Stripe
  // applies no allowlist of its own to `return_url`, so resolveOrigin's exact
  // match against ALLOWED_REDIRECT_ORIGINS is the only control on this value.
  const websiteUrl = resolveOrigin(event);
  const stripe = getStripeClient();

  // The org's record. Every member reaches the same one.
  const record = await readSubscription(orgId);

  if (!record) {
    return new ResponseBuilder().status(400).body({ message: 'No billing record found.' }).build();
  }

  const { stripeCustomerId } = record;

  if (!stripeCustomerId) {
    return new ResponseBuilder().status(400).body({ message: 'No Stripe customer found.' }).build();
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
  .use(authorize('billing.manage'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
