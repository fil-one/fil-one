import { DeleteItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import Stripe from 'stripe';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.ts';
import { getStripeClient, getWebhookSecret } from '../lib/stripe-client.ts';
import { processStripeEvent } from '../jobs/stripe-event-worker.ts';

const dynamo = getDynamoClient();

/**
 * Stripe webhook handler — NO auth middleware.
 * Verifies Stripe signature, processes billing events, and writes to billing table.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const tableName = Resource.BillingTable.name;
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

  // 3. Idempotency — atomic claim-or-skip
  const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days
  const idempotencyKey = { pk: { S: `WEBHOOK#${stripeEvent.id}` }, sk: { S: 'EVENT' } };
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          pk: `WEBHOOK#${stripeEvent.id}`,
          sk: 'EVENT',
          eventType: stripeEvent.type,
          processedAt: new Date().toISOString(),
          ttl,
        }),
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.warn('[stripe-webhook] Already processed event:', stripeEvent.id);
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }
    console.error('[stripe-webhook] Idempotency check failed:', err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Idempotency check error' }) };
  }

  // 4. Process event
  try {
    await processStripeEvent(stripeEvent);
  } catch (err) {
    console.error('[stripe-webhook] Error processing event:', err);
    // Release idempotency claim so Stripe retries can reprocess
    try {
      await dynamo.send(new DeleteItemCommand({ TableName: tableName, Key: idempotencyKey }));
    } catch (deleteErr) {
      console.error('[stripe-webhook] Failed to release idempotency claim:', deleteErr);
    }
    return { statusCode: 500, body: JSON.stringify({ message: 'Processing error' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
}
