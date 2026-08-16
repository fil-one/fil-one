import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { CreateSetupIntentResponse } from '@filone/shared';
import { Resource } from 'sst';
import { getStripeClient } from '../lib/stripe-client.js';
import {
  readSubscription,
  updateSubscription,
  writeSubscription,
} from '../lib/subscription-store.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

// Exported for unit testing (without the auth/csrf middleware chain).
export async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { userId, email, orgId } = getUserInfo(event);
  const stripe = getStripeClient();

  // 1. Check whether the org already has a customer in the billing table
  const existing = await readSubscription(orgId, userId);

  let stripeCustomerId: string;

  if (existing) {
    const { record } = existing;
    if (record.stripeCustomerId) {
      stripeCustomerId = record.stripeCustomerId;
    } else {
      // Create Stripe customer and update record (without clobbering existing fields)
      const customer = await stripe.customers.create({
        email: email ?? undefined,
        // orgId included so webhook writers can backfill it onto records that
        // lack one — records without it are skipped by every lifecycle job.
        metadata: { userId, orgId },
      });
      stripeCustomerId = customer.id;

      await updateSubscription(
        { orgId, userId },
        {
          UpdateExpression: 'SET stripeCustomerId = :cid, updatedAt = :now',
          ExpressionAttributeValues: {
            ':cid': { S: stripeCustomerId },
            ':now': { S: new Date().toISOString() },
          },
        },
      );
    }
  } else {
    // First time — create the Stripe customer and persist only the customer
    // mapping. Trial entitlement is granted only by ensureTrialEntitlement.
    const customer = await stripe.customers.create({
      email: email ?? undefined,
      // orgId included so webhook writers can backfill it onto records that
      // lack one — records without it are skipped by every lifecycle job.
      metadata: { userId, orgId },
    });
    stripeCustomerId = customer.id;

    try {
      // Both keys are born together here: the record does not exist yet, so the
      // org row is whole from its first write rather than a partial twin that
      // would shadow a complete legacy row.
      await writeSubscription(
        { orgId, userId },
        {
          item: {
            stripeCustomerId: { S: stripeCustomerId },
            updatedAt: { S: new Date().toISOString() },
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      );
    } catch (err) {
      // A record already exists
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }

  // 2. Create SetupIntent
  const setupIntent = await stripe.setupIntents.create({
    customer: stripeCustomerId,
    usage: 'off_session',
  });

  const response: CreateSetupIntentResponse = {
    clientSecret: setupIntent.client_secret!,
    stripePublishableKey: Resource.StripePublishableKey.value,
  };

  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('billing.manage'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
