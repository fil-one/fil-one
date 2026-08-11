import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { CreateSetupIntentResponse } from '@filone/shared';
import { Resource } from 'sst';
import { accountDeletedResponse } from '../lib/account-deleted-response.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { sendGuardedBillingUpdate } from '../lib/deletion-guard.js';
import { isIdentityTombstoned } from '../lib/identity-tombstone.js';
import { getStripeClient } from '../lib/stripe-client.js';
import { ResponseBuilder } from '../lib/response-builder.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { getUserInfo } from '../lib/user-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfMiddleware } from '../middleware/csrf.js';
import { errorHandlerMiddleware } from '../middleware/error-handler.js';

const dynamo = getDynamoClient();

// Exported for unit testing (without the auth/csrf middleware chain).
export async function baseHandler(event: AuthenticatedEvent): Promise<APIGatewayProxyResultV2> {
  const { sub, userId, email, orgId } = getUserInfo(event);
  const tableName = Resource.BillingTable.name;
  const stripe = getStripeClient();

  // FIL-112 cheap pre-check: this handler mints a Stripe customer BEFORE its
  // DB write, so without it a deleted identity leaves a live Stripe customer
  // behind on every retry. The post-write verification further down is what
  // actually closes the race; this only keeps the common case clean.
  if (await isIdentityTombstoned({ sub })) return accountDeletedResponse();

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
      // Create Stripe customer and update record (without clobbering existing fields)
      const customer = await stripe.customers.create({
        email: email ?? undefined,
        // orgId included so webhook writers can backfill it onto records that
        // lack one — records without it are skipped by every lifecycle job.
        metadata: { userId, orgId },
      });
      stripeCustomerId = customer.id;

      // Deletion-guarded (FIL-112): the record may have been purged or claimed
      // by teardown since the read above. Guard rejection means the account is
      // going away — don't mint a SetupIntent against it.
      const updated = await sendGuardedBillingUpdate({
        TableName: tableName,
        Key: {
          pk: { S: `CUSTOMER#${userId}` },
          sk: { S: 'SUBSCRIPTION' },
        },
        UpdateExpression: 'SET stripeCustomerId = :cid, updatedAt = :now',
        ExpressionAttributeValues: {
          ':cid': { S: stripeCustomerId },
          ':now': { S: new Date().toISOString() },
        },
      });
      if (!updated) return accountDeletedResponse();
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
      await dynamo.send(
        new PutItemCommand({
          TableName: tableName,
          Item: marshall({
            pk: `CUSTOMER#${userId}`,
            sk: 'SUBSCRIPTION',
            stripeCustomerId,
            orgId,
            updatedAt: new Date().toISOString(),
          }),
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (err) {
      // A record already exists
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }

    // FIL-112 post-write verification: the tombstone is armed strictly before
    // teardown purges billing, so seeing it now means the record we just wrote
    // is a resurrection. Delete it.
    if (await isIdentityTombstoned({ sub })) {
      await dynamo.send(
        new DeleteItemCommand({
          TableName: tableName,
          Key: { pk: { S: `CUSTOMER#${userId}` }, sk: { S: 'SUBSCRIPTION' } },
        }),
      );
      // A request that raced past the top check still orphans the Stripe
      // customer created above; teardown's metadata-based discovery sweeps it
      // (both create sites here stamp metadata { userId, orgId }).
      return accountDeletedResponse();
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
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
