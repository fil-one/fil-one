import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { UsageReportingWorkerPayload } from './usage-reporting-worker.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
  },
}));

const mockMeterEventsCreate = vi.fn().mockResolvedValue({});
vi.mock('../lib/stripe-client.js', () => ({
  getStripeClient: () => ({
    billing: {
      meterEvents: { create: mockMeterEventsCreate },
    },
  }),
}));

const mockGetStorageSamples = vi.fn();
vi.mock('../lib/aurora-backoffice.js', () => ({
  getStorageSamples: (...args: unknown[]) => mockGetStorageSamples(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.STRIPE_METER_EVENT_NAME = 'storage_usage';

import { handler } from './usage-reporting-worker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const basePayload: UsageReportingWorkerPayload = {
  orgId: 'org-1',
  subscriptionId: 'sub_123',
  stripeCustomerId: 'cus_123',
  currentPeriodStart: '2024-01-01T00:00:00Z',
  reportDate: '2024-01-15',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usage-reporting-worker', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    ddbMock.on(PutItemCommand).resolves({});
  });

  it('reports usage to Stripe and writes audit record', async () => {
    mockGetStorageSamples.mockResolvedValue([
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_099_511_627_776 },
    ]);

    await handler(basePayload);

    expect(mockMeterEventsCreate).toHaveBeenCalledOnce();
    expect(mockMeterEventsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: 'storage_usage',
        payload: {
          stripe_customer_id: 'cus_123',
          value: '1',
        },
      }),
    );

    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item!;
    expect(item.pk).toEqual({ S: 'ORG#org-1' });
    expect(item.sk).toEqual({ S: 'USAGE_REPORT#2024-01-15' });
    expect(item.reportedToStripe).toEqual({ BOOL: true });
  });

  it('skips Stripe when usage is zero, still writes audit', async () => {
    mockGetStorageSamples.mockResolvedValue([]);

    await handler(basePayload);

    expect(mockMeterEventsCreate).not.toHaveBeenCalled();

    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item!;
    expect(item.reportedToStripe).toEqual({ BOOL: false });
  });

  it('propagates Stripe API failure', async () => {
    mockGetStorageSamples.mockResolvedValue([
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1000 },
    ]);
    mockMeterEventsCreate.mockRejectedValueOnce(new Error('Stripe error'));

    await expect(handler(basePayload)).rejects.toThrow('Stripe error');
  });

  it('propagates Aurora API failure', async () => {
    mockGetStorageSamples.mockRejectedValue(new Error('Aurora timeout'));

    await expect(handler(basePayload)).rejects.toThrow('Aurora timeout');
  });

  it('writes correct audit record fields', async () => {
    mockGetStorageSamples.mockResolvedValue([
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 500 },
      { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 1500 },
    ]);

    await handler(basePayload);

    const putCalls = ddbMock.commandCalls(PutItemCommand);
    const item = putCalls[0].args[0].input.Item!;
    expect(item.pk).toEqual({ S: 'ORG#org-1' });
    expect(item.sk).toEqual({ S: 'USAGE_REPORT#2024-01-15' });
    expect(item.orgId).toEqual({ S: 'org-1' });
    expect(item.sampleCount).toEqual({ N: '2' });
    expect(item.averageStorageBytesUsed).toEqual({ N: '1000' });
    expect(item.ttl).toBeDefined();
  });
});
