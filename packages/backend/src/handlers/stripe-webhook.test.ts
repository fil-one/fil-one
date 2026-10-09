import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { buildEvent } from '../test/lambda-test-utilities.ts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: { BillingTable: { name: 'BillingTable' } },
}));

// The webhook acknowledges Stripe before any processing, so it must not even
// load the orchestrator clients: importing them costs cold-start time, and
// this mock fails the whole file if anything on the webhook's import path does.
// The module mocks below spread the real modules so their imports load too.
vi.mock('../lib/service-orchestrator-registry.ts', () => {
  throw new Error('the Stripe webhook must not load the orchestrator registry');
});

const mockConstructEvent = vi.fn();
const mockCustomersRetrieve = vi.fn();

vi.mock('../lib/stripe-client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/stripe-client.ts')>()),
  getStripeClient: () => ({
    webhooks: { constructEvent: mockConstructEvent },
    customers: { retrieve: mockCustomersRetrieve },
  }),
  getWebhookSecret: vi.fn().mockResolvedValue('whsec_test_fake'),
}));

const mockEnqueueStripeEvent = vi.fn();
vi.mock('../lib/stripe-event-queue.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/stripe-event-queue.ts')>()),
  enqueueStripeEvent: (...args: unknown[]) => mockEnqueueStripeEvent(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

import { handler } from './stripe-webhook.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STRIPE_EVENT = {
  id: 'evt_test_789',
  type: 'invoice.payment_failed',
  data: { object: { object: 'invoice', customer: 'cus_test_123' } },
};

function buildWebhookEvent(body: string, opts?: { isBase64Encoded?: boolean }) {
  const evt = buildEvent();
  evt.headers['stripe-signature'] = 'sig_test';
  evt.body = opts?.isBase64Encoded ? Buffer.from(body).toString('base64') : body;
  evt.isBase64Encoded = opts?.isBase64Encoded ?? false;
  return evt;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stripe-webhook handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    ddbMock.on(PutItemCommand).resolves({});
    mockConstructEvent.mockReset();
    mockConstructEvent.mockReturnValue(STRIPE_EVENT);
    mockCustomersRetrieve.mockReset();
    mockEnqueueStripeEvent.mockReset();
    mockEnqueueStripeEvent.mockResolvedValue(undefined);
  });

  describe('signature verification', () => {
    it('returns 400 when stripe-signature header missing', async () => {
      const result = await handler(buildEvent());

      expect(result).toEqual({
        statusCode: 400,
        body: JSON.stringify({ message: 'Missing stripe-signature header' }),
      });
      expect(mockEnqueueStripeEvent).not.toHaveBeenCalled();
    });

    it('returns 400 when constructEvent throws (invalid signature)', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      const result = await handler(buildWebhookEvent('{}'));

      expect(result).toEqual({
        statusCode: 400,
        body: JSON.stringify({ message: 'Invalid signature' }),
      });
      expect(mockEnqueueStripeEvent).not.toHaveBeenCalled();
    });

    it('decodes base64 body before verification', async () => {
      const rawBody = JSON.stringify({ test: true });

      await handler(buildWebhookEvent(rawBody, { isBase64Encoded: true }));

      expect(mockConstructEvent).toHaveBeenCalledWith(rawBody, 'sig_test', 'whsec_test_fake');
    });
  });

  describe('hand-off to the worker', () => {
    it('enqueues the verified event and acknowledges Stripe', async () => {
      const result = await handler(buildWebhookEvent('{}'));

      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
      expect(mockEnqueueStripeEvent).toHaveBeenCalledExactlyOnceWith(STRIPE_EVENT);
    });

    it('returns 500 when the event cannot be enqueued, so Stripe retries', async () => {
      mockEnqueueStripeEvent.mockRejectedValue(new Error('SQS unavailable'));

      const result = await handler(buildWebhookEvent('{}'));

      expect(result).toEqual({
        statusCode: 500,
        body: JSON.stringify({ message: 'Enqueue error' }),
      });
    });

    it('makes no Stripe API call while Stripe waits', async () => {
      await handler(buildWebhookEvent('{}'));

      expect(mockCustomersRetrieve).not.toHaveBeenCalled();
    });
  });

  describe('deduplication', () => {
    const MARK_KEY = { pk: { S: `WEBHOOK#${STRIPE_EVENT.id}` }, sk: { S: 'EVENT' } };

    it('acknowledges an event already received without enqueueing it again', async () => {
      ddbMock
        .on(GetItemCommand, { Key: MARK_KEY })
        .resolves({ Item: { ...MARK_KEY, eventType: { S: STRIPE_EVENT.type } } });

      const result = await handler(buildWebhookEvent('{}'));

      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
      expect(mockEnqueueStripeEvent).not.toHaveBeenCalled();
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    });

    it('reads the mark with a strongly consistent read', async () => {
      await handler(buildWebhookEvent('{}'));

      expect(ddbMock.commandCalls(GetItemCommand)[0].args[0].input).toStrictEqual({
        TableName: 'BillingTable',
        Key: MARK_KEY,
        ConsistentRead: true,
      });
    });

    it('writes the mark only after the event is enqueued', async () => {
      // Marking first would lose the event if the enqueue then failed: Stripe's
      // retry would find the mark and be acknowledged with nothing queued.
      mockEnqueueStripeEvent.mockImplementation(async () => {
        expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
      });

      await handler(buildWebhookEvent('{}'));

      expect(mockEnqueueStripeEvent).toHaveBeenCalledOnce();
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
    });

    it('marks the event with its type and a 30-day TTL', async () => {
      const before = Math.floor(Date.now() / 1000);
      await handler(buildWebhookEvent('{}'));
      const after = Math.floor(Date.now() / 1000);

      const input = ddbMock.commandCalls(PutItemCommand)[0].args[0].input;
      expect(input).toStrictEqual({
        TableName: 'BillingTable',
        Item: {
          ...MARK_KEY,
          eventType: { S: STRIPE_EVENT.type },
          processedAt: { S: expect.any(String) },
          ttl: { N: expect.any(String) },
        },
      });

      const ttl = Number(input.Item!.ttl.N);
      const thirtyDays = 30 * 24 * 60 * 60;
      expect(ttl).toBeGreaterThanOrEqual(before + thirtyDays);
      expect(ttl).toBeLessThanOrEqual(after + thirtyDays + 1);
    });

    it('does not mark an event it failed to enqueue', async () => {
      mockEnqueueStripeEvent.mockRejectedValue(new Error('SQS unavailable'));

      await handler(buildWebhookEvent('{}'));

      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    });

    it('returns 500 when the mark cannot be read, so Stripe retries', async () => {
      ddbMock.on(GetItemCommand).rejects(new Error('DynamoDB get failed'));

      const result = await handler(buildWebhookEvent('{}'));

      expect(result).toEqual({
        statusCode: 500,
        body: JSON.stringify({ message: 'Idempotency check error' }),
      });
      expect(mockEnqueueStripeEvent).not.toHaveBeenCalled();
    });

    it('acknowledges a queued event, with an error log, when the mark cannot be written', async () => {
      // The event is queued. Without the mark, a later duplicate from Stripe
      // would be handled again, which the handlers tolerate.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      ddbMock.on(PutItemCommand).rejects(new Error('DynamoDB put failed'));

      const result = await handler(buildWebhookEvent('{}'));

      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
      expect(errorSpy).toHaveBeenCalledWith(
        '[stripe-webhook] Failed to mark event received:',
        STRIPE_EVENT.id,
        expect.objectContaining({ message: 'DynamoDB put failed' }),
      );
      errorSpy.mockRestore();
    });
  });
});
