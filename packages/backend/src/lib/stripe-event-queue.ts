// Delivery for the Stripe event worker.
//
// The webhook verifies Stripe's signature and hands the event to this queue,
// so it can acknowledge Stripe before any lookup or orchestrator call runs.
// SQS redelivers a failed event and gives up into a dead-letter queue after a
// bounded number of attempts.
//
// FIFO, grouped by Stripe customer: SQS keeps at most one message per group in
// flight, so two events for the same customer never run at once (a payment
// success cannot race the cancellation it follows). Deduplicating on the event
// id drops Stripe's own redeliveries that arrive within the 5-minute window;
// the worker's processed-event mark catches later ones.

import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type Stripe from 'stripe';
import { Resource } from 'sst';

const sqs = new SQSClient({});

export async function enqueueStripeEvent(event: Stripe.Event): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: Resource.StripeEventQueue.url,
      MessageBody: JSON.stringify(event),
      MessageGroupId: customerIdOf(event) ?? event.id,
      MessageDeduplicationId: event.id,
    }),
  );
}

/** The customer an event concerns: the object itself, or the customer it names. */
function customerIdOf(event: Stripe.Event): string | undefined {
  const object = event.data.object as { object?: string; id?: string; customer?: unknown };
  if (object.object === 'customer') return object.id;
  const customer = object.customer;
  if (typeof customer === 'string') return customer;
  if (customer && typeof customer === 'object' && 'id' in customer) {
    return (customer as { id: string }).id;
  }
  return undefined;
}
