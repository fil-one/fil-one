import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

vi.mock('sst', () => ({
  Resource: { StripeEventQueue: { url: 'https://sqs.example.com/stripe-event.fifo' } },
}));

const { sendMock, clientConfigs } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  clientConfigs: [] as unknown[],
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = sendMock;

    constructor(config: unknown) {
      clientConfigs.push(config);
    }
  },
  SendMessageCommand: class {
    input: Record<string, string>;

    constructor(input: Record<string, string>) {
      this.input = input;
    }
  },
}));

import { enqueueStripeEvent } from './stripe-event-queue.ts';

function stripeEvent(type: string, object: Record<string, unknown>): Stripe.Event {
  return { id: 'evt_1', type, data: { object } } as unknown as Stripe.Event;
}

/** The command input the client was handed. */
function sentInput(): Record<string, string> {
  return sendMock.mock.calls[0][0].input;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enqueueStripeEvent', () => {
  it('sends to the regional SQS endpoint rather than the queue URL host', () => {
    // In AWS the two are the same host. A local emulator hands out queue URLs
    // on a host the Lambda cannot reach, and the SDK would otherwise use it.
    expect(clientConfigs).toEqual([{ useQueueUrlAsEndpoint: false }]);
  });

  it('sends the verified event to the queue, deduplicated on its Stripe id', async () => {
    const event = stripeEvent('invoice.finalized', { object: 'invoice', customer: 'cus_1' });

    await enqueueStripeEvent(event);

    expect(sentInput().QueueUrl).toBe('https://sqs.example.com/stripe-event.fifo');
    expect(sentInput().MessageDeduplicationId).toBe('evt_1');
    expect(JSON.parse(sentInput().MessageBody)).toEqual(event);
  });

  it('groups a customer event on the customer it describes', async () => {
    await enqueueStripeEvent(stripeEvent('customer.updated', { object: 'customer', id: 'cus_1' }));

    expect(sentInput().MessageGroupId).toBe('cus_1');
  });

  it('groups a subscription or invoice event on the customer it names', async () => {
    await enqueueStripeEvent(
      stripeEvent('customer.subscription.deleted', { object: 'subscription', customer: 'cus_1' }),
    );
    await enqueueStripeEvent(
      stripeEvent('invoice.payment_failed', {
        object: 'invoice',
        customer: { object: 'customer', id: 'cus_2' },
      }),
    );

    expect(sendMock.mock.calls[0][0].input.MessageGroupId).toBe('cus_1');
    expect(sendMock.mock.calls[1][0].input.MessageGroupId).toBe('cus_2');
  });

  it('groups an event naming no customer on its own id', async () => {
    await enqueueStripeEvent(
      stripeEvent('invoice.finalized', { object: 'invoice', customer: null }),
    );

    expect(sentInput().MessageGroupId).toBe('evt_1');
  });
});
