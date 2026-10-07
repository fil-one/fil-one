import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import Stripe from 'stripe';
import { getStripeClient, getWebhookSecret } from '../lib/stripe-client.ts';
import { enqueueStripeEvent } from '../lib/stripe-event-queue.ts';

/**
 * Stripe webhook handler — NO auth middleware.
 * Verifies the Stripe signature and enqueues the event for the Stripe event
 * worker (jobs/stripe-event-worker.ts), which processes it.
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

  // 3. Hand off to the worker. Everything slow (Stripe lookups, orchestrator
  // status syncs) runs there, after Stripe has its 2xx. A failed enqueue
  // returns 500 so Stripe retries the delivery.
  try {
    await enqueueStripeEvent(stripeEvent);
  } catch (err) {
    console.error('[stripe-webhook] Failed to enqueue event:', stripeEvent.id, err);
    return { statusCode: 500, body: JSON.stringify({ message: 'Enqueue error' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
}
