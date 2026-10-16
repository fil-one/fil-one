import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import Stripe from 'stripe';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.ts';
import { getStripeClient, getWebhookSecret } from '../lib/stripe-client.ts';
import { enqueueStripeEvent } from '../lib/stripe-event-queue.ts';

const dynamo = getDynamoClient();

/**
 * Stripe webhook handler — NO auth middleware.
 * Verifies the Stripe signature, drops an event it has already received, and
 * enqueues the rest for the Stripe event worker (jobs/stripe-event-worker.ts),
 * which processes them.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const stripe = getStripeClient();

  // 1. Get raw body for signature verification
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
    : (event.body ?? '');

  const signatureHeader = event.headers['stripe-signature'];

  if (!signatureHeader) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'Missing stripe-signature header' }),
    };
  }

  // 2. Verify webhook signature
  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      await getWebhookSecret(),
    );
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', err);
    return { statusCode: 400, body: JSON.stringify({ message: 'Invalid signature' }) };
  }

  // 3. Deduplicate. Stripe may deliver an event more than once; the queue's
  // own deduplication covers only 5 minutes, so a received event is marked.
  const tableName = Resource.BillingTable.name;
  const markKey = { pk: `WEBHOOK#${stripeEvent.id}`, sk: 'EVENT' };
  try {
    const { Item: mark } = await dynamo.send(
      new GetItemCommand({ TableName: tableName, Key: marshall(markKey), ConsistentRead: true }),
    );
    if (mark) {
      console.warn('[stripe-webhook] Already received event:', stripeEvent.id);
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }
  } catch (err) {
    console.error('[stripe-webhook] Idempotency check failed:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Idempotency check error' }) };
  }

  // 4. Hand off to the worker. Everything slow (Stripe lookups, orchestrator
  // status syncs) runs there, after Stripe has its 2xx. A failed enqueue
  // returns 500 so Stripe retries the delivery.
  try {
    await enqueueStripeEvent(stripeEvent);
  } catch (err) {
    console.error('[stripe-webhook] Failed to enqueue event:', stripeEvent.id, err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Enqueue error' }) };
  }

  // 5. Mark the event only once it is queued: marking first would lose it if
  // the enqueue failed, because Stripe's retry would find the mark. A failed
  // mark is logged, not returned: the event is queued, and at worst a later
  // duplicate from Stripe is handled again, which the handlers tolerate.
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          ...markKey,
          eventType: stripeEvent.type,
          processedAt: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
        }),
      }),
    );
  } catch (err) {
    console.error('[stripe-webhook] Failed to mark event received:', stripeEvent.id, err);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
}
