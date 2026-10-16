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

function buildStripeEvent(type: string, object: Record<string, unknown>): Stripe.Event {
  return { id: 'evt_1', type, data: { object } } as unknown as Stripe.Event;
}

/** The command input the client was handed. */
function getSentInput(): Record<string, string> {
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
    const event = buildStripeEvent('invoice.finalized', {
      object: 'invoice',
      id: 'in_1',
      customer: 'cus_1',
    });

    await enqueueStripeEvent(event);

    expect(getSentInput()).toStrictEqual({
      QueueUrl: 'https://sqs.example.com/stripe-event.fifo',
      MessageBody: JSON.stringify(event),
      MessageGroupId: 'cus_1',
      MessageDeduplicationId: 'evt_1',
    });
  });

  it('groups a customer event on the customer it describes', async () => {
    await enqueueStripeEvent(
      buildStripeEvent('customer.updated', { object: 'customer', id: 'cus_1' }),
    );

    expect(getSentInput().MessageGroupId).toBe('cus_1');
  });

  // Each object carries its own id, so grouping on that id instead of the
  // customer's would fail these.
  it.each([
    [
      'a subscription naming a customer id',
      { object: 'subscription', id: 'sub_1', customer: 'cus_1' },
    ],
    ['an invoice naming a customer id', { object: 'invoice', id: 'in_1', customer: 'cus_1' }],
    [
      'an invoice with an expanded customer',
      { object: 'invoice', id: 'in_1', customer: { object: 'customer', id: 'cus_1' } },
    ],
  ])('groups %s on that customer', async (_, object) => {
    await enqueueStripeEvent(buildStripeEvent('invoice.payment_failed', object));

    expect(getSentInput().MessageGroupId).toBe('cus_1');
  });

  it('groups an event naming no customer on its own id', async () => {
    await enqueueStripeEvent(
      buildStripeEvent('invoice.finalized', { object: 'invoice', id: 'in_1', customer: null }),
    );

    expect(getSentInput().MessageGroupId).toBe('evt_1');
  });
});
