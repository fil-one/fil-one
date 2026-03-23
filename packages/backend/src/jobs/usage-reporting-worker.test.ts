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
const mockGetOperationsSamples = vi.fn().mockResolvedValue([]);
const mockGetTenantInfo = vi.fn().mockResolvedValue({ status: 'ACTIVE' });
const mockUpdateTenantStatus = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/aurora-backoffice.js', () => ({
  getStorageSamples: (...args: unknown[]) => mockGetStorageSamples(...args),
  getOperationsSamples: (...args: unknown[]) => mockGetOperationsSamples(...args),
  getTenantInfo: (...args: unknown[]) => mockGetTenantInfo(...args),
  updateTenantStatus: (...args: unknown[]) => mockUpdateTenantStatus(...args),
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.STRIPE_METER_EVENT_NAME = 'storage_usage';

import { handler } from './usage-reporting-worker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const basePayload: UsageReportingWorkerPayload = {
  orgId: 'org-1',
  auroraTenantId: 'aurora-tenant-123',
  subscriptionId: 'sub_123',
  stripeCustomerId: 'cus_123',
  currentPeriodStart: '2024-01-01T00:00:00Z',
  subscriptionStatus: 'active',
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

  it('calls getStorageSamples with auroraTenantId, not orgId', async () => {
    mockGetStorageSamples.mockResolvedValue([]);

    await handler(basePayload);

    expect(mockGetStorageSamples).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'aurora-tenant-123' }),
    );
    expect(mockGetStorageSamples).not.toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'org-1' }),
    );
  });

  it('reports usage to Stripe and writes audit record', async () => {
    mockGetStorageSamples.mockResolvedValue([
      { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_000_000_000_000 },
    ]);

    await handler(basePayload);

    expect(mockMeterEventsCreate).toHaveBeenCalledOnce();
    expect(mockMeterEventsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: 'storage_usage',
        payload: {
          stripe_customer_id: 'cus_123',
          value: '1000',
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

  it('paid user records lockAction as skipped:paid', async () => {
    mockGetStorageSamples.mockResolvedValue([]);

    await handler(basePayload);

    expect(mockGetTenantInfo).not.toHaveBeenCalled();
    expect(mockUpdateTenantStatus).not.toHaveBeenCalled();
    const putCalls = ddbMock.commandCalls(PutItemCommand);
    const item = putCalls[0].args[0].input.Item!;
    expect(item.lockAction).toEqual({ S: 'skipped:paid' });
  });

  describe('trial lock enforcement', () => {
    const trialPayload: UsageReportingWorkerPayload = {
      ...basePayload,
      subscriptionStatus: 'trialing',
    };

    it('trial under limits — no status change', async () => {
      mockGetStorageSamples.mockResolvedValue([
        { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 500_000_000_000 }, // 500 GB
      ]);
      mockGetOperationsSamples.mockResolvedValue([
        { timestamp: '2024-01-01T00:00:00Z', rxBytes: 1_000_000_000_000 }, // 1 TB
      ]);
      mockGetTenantInfo.mockResolvedValue({ status: 'ACTIVE' });

      await handler(trialPayload);

      expect(mockGetTenantInfo).toHaveBeenCalledOnce();
      expect(mockUpdateTenantStatus).not.toHaveBeenCalled();
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'ACTIVE' });
    });

    it('trial storage exceeded — WRITE_LOCKED', async () => {
      mockGetStorageSamples.mockResolvedValue([
        { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_500_000_000_000 }, // 1.5 TB
      ]);
      mockGetOperationsSamples.mockResolvedValue([]);
      mockGetTenantInfo.mockResolvedValue({ status: 'ACTIVE' });

      await handler(trialPayload);

      expect(mockUpdateTenantStatus).toHaveBeenCalledWith({
        tenantId: 'aurora-tenant-123',
        status: 'WRITE_LOCKED',
      });
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'WRITE_LOCKED' });
    });

    it('trial egress exceeded — DISABLED', async () => {
      mockGetStorageSamples.mockResolvedValue([
        { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 0 },
      ]);
      mockGetOperationsSamples.mockResolvedValue([
        { timestamp: '2024-01-01T00:00:00Z', rxBytes: 2_500_000_000_000 }, // 2.5 TB
      ]);
      mockGetTenantInfo.mockResolvedValue({ status: 'ACTIVE' });

      await handler(trialPayload);

      expect(mockUpdateTenantStatus).toHaveBeenCalledWith({
        tenantId: 'aurora-tenant-123',
        status: 'DISABLED',
      });
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'DISABLED' });
    });

    it('trial both exceeded — DISABLED takes priority over WRITE_LOCKED', async () => {
      mockGetStorageSamples.mockResolvedValue([
        { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_500_000_000_000 }, // 1.5 TB
      ]);
      mockGetOperationsSamples.mockResolvedValue([
        { timestamp: '2024-01-01T00:00:00Z', rxBytes: 2_500_000_000_000 }, // 2.5 TB
      ]);
      mockGetTenantInfo.mockResolvedValue({ status: 'ACTIVE' });

      await handler(trialPayload);

      expect(mockUpdateTenantStatus).toHaveBeenCalledWith({
        tenantId: 'aurora-tenant-123',
        status: 'DISABLED',
      });
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'DISABLED' });
    });

    it('audit record includes totalEgressBytes', async () => {
      mockGetStorageSamples.mockResolvedValue([]);
      mockGetOperationsSamples.mockResolvedValue([
        { timestamp: '2024-01-01T00:00:00Z', rxBytes: 500_000_000_000 }, // 500 GB
      ]);
      mockGetTenantInfo.mockResolvedValue({ status: 'ACTIVE' });

      await handler(trialPayload);

      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.totalEgressBytes).toEqual({ N: '500000000000' });
    });

    it('records error in lockAction when enforcement fails', async () => {
      mockGetStorageSamples.mockResolvedValue([
        { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_500_000_000_000 },
      ]);
      mockGetOperationsSamples.mockResolvedValue([]);
      mockGetTenantInfo.mockResolvedValue({ status: 'ACTIVE' });
      mockUpdateTenantStatus.mockRejectedValueOnce(new Error('Aurora down'));

      await handler(trialPayload);

      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'error:Aurora down' });
    });
  });
});
