import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { sstResourceMock } from '../test/sst-resource-mock.ts';
import type { SQSEvent } from 'aws-lambda';

vi.mock('sst', () => sstResourceMock());
vi.mock('../lib/stripe-client.ts', () => ({ getStripeClient: vi.fn() }));
vi.mock('../lib/region-helpers.ts', () => ({
  assertTenantSyncSucceeded: vi.fn(),
  syncTenantStatusInProvisionedNetworks: vi.fn(),
}));
vi.mock('../lib/deletion-from-stripe.ts', () => ({ startDeletionFromStripe: vi.fn() }));
const capture = vi.fn<(value: unknown) => Promise<void>>();
const paidMetric = vi.fn();
vi.mock('../lib/billing-lifecycle.ts', () => ({
  captureBillingLifecycle: (value: unknown) => capture(value),
}));
vi.mock('../lib/stripe-webhook-metrics.ts', () => ({
  emitBillingRowMissing: vi.fn(),
  emitDunningEscalation: vi.fn(),
  emitInvoiceFinalizationFailed: vi.fn(),
  emitInvoiceFinalized: vi.fn(),
  emitInvoicePaid: () => paidMetric(),
}));
import { handler } from './stripe-event-worker.ts';

const ddb = mockClient(DynamoDBClient);
const event = {
  id: 'evt_any',
  type: 'invoice.payment_succeeded',
  data: { object: { attempt_count: 1, customer: 'cus_any-customer' } },
};
const queue: SQSEvent = {
  Records: [
    {
      body: JSON.stringify(event),
      messageId: 'any-message',
      receiptHandle: 'any-receipt',
      attributes: {
        ApproximateReceiveCount: '1',
        SentTimestamp: '1',
        SenderId: 'any-sender',
        ApproximateFirstReceiveTimestamp: '1',
      },
      messageAttributes: {},
      md5OfBody: 'any-digest',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-2:654654381893:any-queue',
      awsRegion: 'us-east-2',
    },
  ],
};

beforeEach(() => {
  ddb.reset();
  capture.mockReset().mockResolvedValue(undefined);
  paidMetric.mockReset();
  ddb.on(PutItemCommand).resolves({});
});
afterEach(() => vi.unstubAllEnvs());

describe('verified FIFO lifecycle delivery', () => {
  it('keeps normal metric and handled ordering with real lifecycle capture disabled', async () => {
    vi.stubEnv('FILONE_LIFECYCLE_BILLING_OUTBOX_TABLE', '');
    const original = await vi.importActual<typeof import('../lib/billing-lifecycle.ts')>(
      '../lib/billing-lifecycle.ts',
    );
    capture.mockImplementationOnce(original.captureBillingLifecycle);
    await handler(queue);
    expect(paidMetric).toHaveBeenCalledOnce();
    const writes = ddb.commandCalls(PutItemCommand);
    expect(writes).toHaveLength(1);
    expect(writes[0].args[0].input.TableName).toBe('BillingTable');
  });

  it('captures the exact retained event before the worker writes its handled receipt', async () => {
    capture.mockImplementationOnce(async (original) => {
      expect(original).toStrictEqual(event);
      expect(ddb.commandCalls(PutItemCommand)).toStrictEqual([]);
      expect(paidMetric).not.toHaveBeenCalled();
    });
    await handler(queue);
    expect(capture).toHaveBeenCalledOnce();
    expect(ddb.commandCalls(PutItemCommand)).toHaveLength(1);
    expect(paidMetric).toHaveBeenCalledOnce();
  });

  it('keeps the original queue event retryable instead of marking it handled after a failed outbox write', async () => {
    capture.mockRejectedValueOnce(new Error('Billing lifecycle outbox unavailable'));
    await expect(handler(queue)).rejects.toThrow('Billing lifecycle outbox unavailable');
    expect(ddb.commandCalls(PutItemCommand)).toStrictEqual([]);
    expect(paidMetric).not.toHaveBeenCalled();
    await handler(queue);
    expect(capture.mock.calls.map(([original]) => original)).toStrictEqual([event, event]);
    expect(ddb.commandCalls(PutItemCommand)).toHaveLength(1);
    expect(paidMetric).toHaveBeenCalledOnce();
  });
});
