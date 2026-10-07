import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
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

    it('makes no DynamoDB or Stripe API call while Stripe waits', async () => {
      await handler(buildWebhookEvent('{}'));

      expect(ddbMock.calls()).toHaveLength(0);
      expect(mockCustomersRetrieve).not.toHaveBeenCalled();
    });
  });
});
