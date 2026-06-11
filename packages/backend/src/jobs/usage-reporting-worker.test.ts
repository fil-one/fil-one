import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { UsageReportingWorkerPayload } from './usage-reporting-worker.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockMeterEventsCreate = vi.fn().mockResolvedValue({});
const mockCustomersUpdate = vi.fn().mockResolvedValue({});
vi.mock('../lib/stripe-client.js', () => ({
  getStripeClient: () => ({
    billing: {
      meterEvents: { create: mockMeterEventsCreate },
    },
    customers: { update: mockCustomersUpdate },
  }),
  updateCustomerMetadata: (customerId: string, metadata: Record<string, string>) =>
    mockCustomersUpdate(customerId, { metadata }),
}));

const {
  mockGetTenantUsageMetrics,
  mockAuroraIsTenantReady,
  mockFthIsTenantReady,
  mockAuroraGetTenantStatus,
  mockFthGetTenantStatus,
  mockAuroraUpdateTenantStatus,
  mockFthUpdateTenantStatus,
  auroraOrchestrator,
  fthOrchestrator,
} = vi.hoisted(() => {
  const mockGetTenantUsageMetrics = vi.fn();
  const mockAuroraIsTenantReady = vi.fn();
  const mockFthIsTenantReady = vi.fn();
  const mockAuroraGetTenantStatus = vi.fn();
  const mockFthGetTenantStatus = vi.fn();
  const mockAuroraUpdateTenantStatus = vi.fn();
  const mockFthUpdateTenantStatus = vi.fn();
  return {
    mockGetTenantUsageMetrics,
    mockAuroraIsTenantReady,
    mockFthIsTenantReady,
    mockAuroraGetTenantStatus,
    mockFthGetTenantStatus,
    mockAuroraUpdateTenantStatus,
    mockFthUpdateTenantStatus,
    auroraOrchestrator: {
      id: 'aurora',
      region: 'eu-west-1',
      isTenantReady: mockAuroraIsTenantReady,
      getTenantUsageMetrics: mockGetTenantUsageMetrics,
      getTenantStatus: mockAuroraGetTenantStatus,
      updateTenantStatus: mockAuroraUpdateTenantStatus,
    },
    fthOrchestrator: {
      id: 'fth',
      region: 'us-east-1',
      isTenantReady: mockFthIsTenantReady,
      getTenantUsageMetrics: mockGetTenantUsageMetrics,
      getTenantStatus: mockFthGetTenantStatus,
      updateTenantStatus: mockFthUpdateTenantStatus,
    },
  };
});
vi.mock('../lib/aurora/aurora-orchestrator.js', () => ({ auroraOrchestrator }));
vi.mock('../lib/fth/fth-orchestrator.js', () => ({ fthOrchestrator }));
vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: () => [auroraOrchestrator, fthOrchestrator],
}));
vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
}));

const ddbMock = mockClient(DynamoDBClient);

process.env.STRIPE_METER_EVENT_NAME = 'storage_usage';
// Registry is mocked, so the value is irrelevant — only presence matters.
process.env.FILONE_STAGE = 'test';

import { handler } from './usage-reporting-worker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const basePayload: UsageReportingWorkerPayload = {
  orgId: 'org-1',
  orgName: 'Acme Corp',
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
    mockGetTenantUsageMetrics.mockResolvedValue({ storage: [], egress: [] });
    // Default: org provisioned in Aurora only (mirrors the previous Aurora-only basePayload).
    mockAuroraIsTenantReady.mockReturnValue('aurora-tenant-123');
    mockFthIsTenantReady.mockReturnValue(null);
    mockAuroraGetTenantStatus.mockResolvedValue({ kind: 'ok', status: 'active' });
    mockFthGetTenantStatus.mockResolvedValue({ kind: 'ok', status: 'active' });
    mockAuroraUpdateTenantStatus.mockResolvedValue(undefined);
    mockFthUpdateTenantStatus.mockResolvedValue(undefined);
  });

  it('calls getTenantUsageMetrics with auroraTenantId, not orgId', async () => {
    mockGetTenantUsageMetrics.mockResolvedValue({ storage: [], egress: [] });

    await handler(basePayload);

    expect(mockGetTenantUsageMetrics).toHaveBeenCalledWith(
      'aurora-tenant-123',
      expect.objectContaining({ interval: '1d' }),
    );
    expect(mockGetTenantUsageMetrics).not.toHaveBeenCalledWith('org-1', expect.anything());
  });

  it('reports usage to Stripe and writes audit record', async () => {
    mockGetTenantUsageMetrics.mockResolvedValue({
      storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_000_000_000_000 }],
      egress: [],
    });

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
    mockGetTenantUsageMetrics.mockResolvedValue({ storage: [], egress: [] });

    await handler(basePayload);

    expect(mockMeterEventsCreate).not.toHaveBeenCalled();

    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item!;
    expect(item.reportedToStripe).toEqual({ BOOL: false });
  });

  it('propagates Stripe API failure', async () => {
    mockGetTenantUsageMetrics.mockResolvedValue({
      storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1000 }],
      egress: [],
    });
    mockMeterEventsCreate.mockRejectedValueOnce(new Error('Stripe error'));

    await expect(handler(basePayload)).rejects.toThrow('Stripe error');
  });

  it('propagates orchestrator API failure', async () => {
    mockGetTenantUsageMetrics.mockRejectedValue(new Error('Aurora timeout'));

    await expect(handler(basePayload)).rejects.toThrow('Aurora timeout');
  });

  it('writes correct audit record fields', async () => {
    mockGetTenantUsageMetrics.mockResolvedValue({
      storage: [
        { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 500 },
        { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 1500 },
      ],
      egress: [],
    });

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
    mockGetTenantUsageMetrics.mockResolvedValue({ storage: [], egress: [] });

    await handler(basePayload);

    expect(mockAuroraGetTenantStatus).not.toHaveBeenCalled();
    expect(mockAuroraUpdateTenantStatus).not.toHaveBeenCalled();
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
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 500_000_000_000 }], // 500 GB
        egress: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_000_000_000_000 }], // 1 TB
      });

      await handler(trialPayload);

      expect(mockAuroraGetTenantStatus).toHaveBeenCalledOnce();
      expect(mockAuroraUpdateTenantStatus).not.toHaveBeenCalled();
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'active' });
    });

    it('trial storage exceeded — write-locked', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_500_000_000_000 }], // 1.5 TB
        egress: [],
      });

      await handler(trialPayload);

      expect(mockAuroraUpdateTenantStatus).toHaveBeenCalledWith(
        'aurora-tenant-123',
        'write-locked',
      );
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'write-locked' });
    });

    it('trial egress exceeded — disabled', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 0 }],
        egress: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 2_500_000_000_000 }], // 2.5 TB
      });

      await handler(trialPayload);

      expect(mockAuroraUpdateTenantStatus).toHaveBeenCalledWith('aurora-tenant-123', 'disabled');
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'disabled' });
    });

    it('trial both exceeded — disabled takes priority over write-locked', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_500_000_000_000 }], // 1.5 TB
        egress: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 2_500_000_000_000 }], // 2.5 TB
      });

      await handler(trialPayload);

      expect(mockAuroraUpdateTenantStatus).toHaveBeenCalledWith('aurora-tenant-123', 'disabled');
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'disabled' });
    });

    it('audit record includes totalEgressBytes', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [],
        egress: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 500_000_000_000 }], // 500 GB
      });

      await handler(trialPayload);

      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.totalEgressBytes).toEqual({ N: '500000000000' });
    });

    it('records error in lockAction when the status update fails', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_500_000_000_000 }],
        egress: [],
      });
      mockAuroraUpdateTenantStatus.mockRejectedValueOnce(new Error('Aurora down'));

      await handler(trialPayload);

      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'error:sync-failed:aurora' });
    });
  });

  // -----------------------------------------------------------------------
  // STRIPE_METER_EVENT_NAME validation
  // -----------------------------------------------------------------------
  describe('STRIPE_METER_EVENT_NAME validation', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('throws a descriptive error when env var is unset', async () => {
      vi.stubEnv('STRIPE_METER_EVENT_NAME', undefined);
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_000_000_000_000 }],
        egress: [],
      });

      await expect(handler(basePayload)).rejects.toThrow(
        'STRIPE_METER_EVENT_NAME env var is not set',
      );
      expect(mockMeterEventsCreate).not.toHaveBeenCalled();
    });

    it('throws a descriptive error when env var is empty string', async () => {
      vi.stubEnv('STRIPE_METER_EVENT_NAME', '');
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_000_000_000_000 }],
        egress: [],
      });

      await expect(handler(basePayload)).rejects.toThrow(
        'STRIPE_METER_EVENT_NAME env var is not set',
      );
      expect(mockMeterEventsCreate).not.toHaveBeenCalled();
    });

    it('validates env var even when usage is zero (fails fast on misconfig)', async () => {
      vi.stubEnv('STRIPE_METER_EVENT_NAME', '');
      mockGetTenantUsageMetrics.mockResolvedValue({ storage: [], egress: [] });

      await expect(handler(basePayload)).rejects.toThrow(
        'STRIPE_METER_EVENT_NAME env var is not set',
      );
      expect(mockMeterEventsCreate).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Stripe resource_missing — customer deleted upstream
  // -----------------------------------------------------------------------
  describe('Stripe resource_missing — customer deleted upstream', () => {
    function makeResourceMissingError(): Error {
      const err = new Error('No such customer: cus_123') as Error & { code: string };
      err.code = 'resource_missing';
      return err;
    }

    it('does not throw when Stripe returns resource_missing', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_000_000_000_000 }],
        egress: [],
      });
      mockMeterEventsCreate.mockRejectedValueOnce(makeResourceMissingError());

      await expect(handler(basePayload)).resolves.toBeUndefined();
    });

    it('audit record has reportedToStripe: false when meter event hits resource_missing', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_000_000_000_000 }],
        egress: [],
      });
      mockMeterEventsCreate.mockRejectedValueOnce(makeResourceMissingError());

      await handler(basePayload);

      const putCalls = ddbMock.commandCalls(PutItemCommand);
      expect(putCalls).toHaveLength(1);
      const item = putCalls[0].args[0].input.Item!;
      expect(item.reportedToStripe).toEqual({ BOOL: false });
    });

    it('logs structured warn with orgId, subscriptionId, stripeCustomerId on resource_missing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_000_000_000_000 }],
        egress: [],
      });
      mockMeterEventsCreate.mockRejectedValueOnce(makeResourceMissingError());

      await handler(basePayload);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Stripe customer missing'),
        expect.objectContaining({
          orgId: 'org-1',
          subscriptionId: 'sub_123',
          stripeCustomerId: 'cus_123',
          code: 'resource_missing',
        }),
      );

      warnSpy.mockRestore();
    });

    it('continues with trial lock enforcement when meter event hits resource_missing', async () => {
      const trialPayload: UsageReportingWorkerPayload = {
        ...basePayload,
        subscriptionStatus: 'trialing',
      };
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_500_000_000_000 }],
        egress: [],
      });
      mockMeterEventsCreate.mockRejectedValueOnce(makeResourceMissingError());

      await handler(trialPayload);

      expect(mockAuroraUpdateTenantStatus).toHaveBeenCalledWith(
        'aurora-tenant-123',
        'write-locked',
      );
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'write-locked' });
      expect(item.reportedToStripe).toEqual({ BOOL: false });
    });

    it('still propagates non-resource_missing Stripe errors', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_000_000_000_000 }],
        egress: [],
      });
      const err = new Error('rate limited') as Error & { code: string };
      err.code = 'rate_limit';
      mockMeterEventsCreate.mockRejectedValueOnce(err);

      await expect(handler(basePayload)).rejects.toThrow('rate limited');
    });
  });

  // -----------------------------------------------------------------------
  // Idempotency — running twice
  // -----------------------------------------------------------------------
  describe('idempotency — running twice', () => {
    it('Stripe meter event is created on every run', async () => {
      // When the orchestrator runs twice per day
      // Each worker invocation reports usage to Stripe independently.
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_000_000_000_000 }],
        egress: [],
      });

      await handler(basePayload);
      await handler(basePayload);

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
      // Both calls report the same usage value
      for (const call of mockMeterEventsCreate.mock.calls) {
        expect(call[0].payload.stripe_customer_id).toBe('cus_123');
        expect(call[0].payload.value).toBe('1000');
      }
    });

    it('DynamoDB audit record uses same pk/sk on both runs (safe overwrite)', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_000_000_000_000 }],
        egress: [],
      });

      await handler(basePayload);
      await handler(basePayload);

      const putCalls = ddbMock.commandCalls(PutItemCommand);
      expect(putCalls).toHaveLength(2);
      // Both writes target the same key — PutItem overwrites safely
      for (const call of putCalls) {
        const item = call.args[0].input.Item!;
        expect(item.pk).toEqual({ S: 'ORG#org-1' });
        expect(item.sk).toEqual({ S: 'USAGE_REPORT#2024-01-15' });
        expect(item.reportedToStripe).toEqual({ BOOL: true });
      }
    });

    it('zero usage — Stripe not called on either run, audit written twice', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({ storage: [], egress: [] });

      await handler(basePayload);
      await handler(basePayload);

      expect(mockMeterEventsCreate).not.toHaveBeenCalled();
      const putCalls = ddbMock.commandCalls(PutItemCommand);
      expect(putCalls).toHaveLength(2);
      for (const call of putCalls) {
        expect(call.args[0].input.Item!.reportedToStripe).toEqual({ BOOL: false });
      }
    });

    it('trial enforcement skips Aurora update on second run when status already matches', async () => {
      const trialPayload: UsageReportingWorkerPayload = {
        ...basePayload,
        subscriptionStatus: 'trialing',
      };
      mockGetTenantUsageMetrics.mockResolvedValue(
        {
          storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_500_000_000_000 }],
          egress: [],
        }, // exceeds trial limit
      );

      // First run: tenant is active → should update to write-locked
      mockAuroraGetTenantStatus.mockResolvedValueOnce({ kind: 'ok', status: 'active' });
      await handler(trialPayload);

      // Second run: tenant is now write-locked (set by first run) → skip update
      mockAuroraGetTenantStatus.mockResolvedValueOnce({ kind: 'ok', status: 'write-locked' });
      await handler(trialPayload);

      expect(mockAuroraUpdateTenantStatus).toHaveBeenCalledTimes(1);
      // Both audit records still written
      const putCalls = ddbMock.commandCalls(PutItemCommand);
      expect(putCalls).toHaveLength(2);
      expect(putCalls[0].args[0].input.Item!.lockAction).toEqual({ S: 'write-locked' });
      expect(putCalls[1].args[0].input.Item!.lockAction).toEqual({ S: 'write-locked' });
    });

    it('paid user — no tenant enforcement on either run', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_000_000_000_000 }],
        egress: [],
      });

      await handler(basePayload);
      await handler(basePayload);

      expect(mockAuroraGetTenantStatus).not.toHaveBeenCalled();
      expect(mockAuroraUpdateTenantStatus).not.toHaveBeenCalled();
      const putCalls = ddbMock.commandCalls(PutItemCommand);
      expect(putCalls).toHaveLength(2);
      for (const call of putCalls) {
        expect(call.args[0].input.Item!.lockAction).toEqual({ S: 'skipped:paid' });
      }
    });
  });

  // -----------------------------------------------------------------------
  // Org metadata sync to Stripe
  // -----------------------------------------------------------------------
  describe('org metadata sync', () => {
    it('syncs organization_name and storage to Stripe with latest snapshot', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [
          { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 500_000_000_000 },
          { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 1_500_000_000_000 },
        ],
        egress: [],
      });

      await handler(basePayload);

      expect(mockCustomersUpdate).toHaveBeenCalledOnce();
      expect(mockCustomersUpdate).toHaveBeenCalledWith('cus_123', {
        metadata: {
          storage_used: '1.5 TB',
          organization_name: 'Acme Corp',
        },
      });
    });

    it('sync failure is swallowed and recorded in audit', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_000_000_000_000 }],
        egress: [],
      });
      mockCustomersUpdate.mockRejectedValueOnce(new Error('Stripe metadata error'));

      await expect(handler(basePayload)).resolves.toBeUndefined();

      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.orgSyncAction.S).toMatch(/^error:/);
    });

    it('skips sync when no org name and zero storage', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({ storage: [], egress: [] });

      await handler({ ...basePayload, orgName: undefined });

      expect(mockCustomersUpdate).not.toHaveBeenCalled();
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.orgSyncAction).toEqual({ S: 'skipped:nothing-to-sync' });
    });

    it('syncs storage only when org name missing', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 2_000_000_000_000 }],
        egress: [],
      });

      await handler({ ...basePayload, orgName: undefined });

      expect(mockCustomersUpdate).toHaveBeenCalledOnce();
      expect(mockCustomersUpdate).toHaveBeenCalledWith('cus_123', {
        metadata: { storage_used: '2 TB' },
      });
    });

    it('audit record includes orgSyncAction on success', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 1_000_000_000_000 }],
        egress: [],
      });

      await handler(basePayload);

      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.orgSyncAction).toEqual({ S: 'ok' });
    });

    it('syncs sub-GB storage with MB units', async () => {
      mockGetTenantUsageMetrics.mockResolvedValue(
        { storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed: 100_000_000 }], egress: [] }, // 100 MB
      );

      await handler({ ...basePayload, orgName: undefined });

      expect(mockCustomersUpdate).toHaveBeenCalledOnce();
      expect(mockCustomersUpdate).toHaveBeenCalledWith('cus_123', {
        metadata: { storage_used: '100 MB' },
      });
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.orgSyncAction).toEqual({ S: 'ok' });
    });

    // ---------------------------------------------------------------------
    // Adaptive unit selection — storage formatted in B / KB / MB / GB / TB
    // ---------------------------------------------------------------------
    describe('adaptive storage units', () => {
      it.each([
        { label: 'bytes', bytesUsed: 500, expected: '500 B' },
        { label: 'kilobytes', bytesUsed: 1_000, expected: '1 KB' },
        { label: 'kilobytes (fractional)', bytesUsed: 1_500, expected: '1.5 KB' },
        { label: 'megabytes', bytesUsed: 5_200_000, expected: '5.2 MB' },
        { label: 'megabytes (round)', bytesUsed: 100_000_000, expected: '100 MB' },
        { label: 'gigabytes', bytesUsed: 10_000_000_000, expected: '10 GB' },
        { label: 'gigabytes (fractional)', bytesUsed: 1_500_000_000, expected: '1.5 GB' },
        { label: 'terabytes', bytesUsed: 1_000_000_000_000, expected: '1 TB' },
        { label: 'terabytes (fractional)', bytesUsed: 2_500_000_000_000, expected: '2.5 TB' },
      ])('formats $label as "$expected"', async ({ bytesUsed, expected }) => {
        mockGetTenantUsageMetrics.mockResolvedValue({
          storage: [{ timestamp: '2024-01-01T00:00:00Z', bytesUsed }],
          egress: [],
        });

        await handler({ ...basePayload, orgName: undefined });

        expect(mockCustomersUpdate).toHaveBeenCalledOnce();
        expect(mockCustomersUpdate).toHaveBeenCalledWith('cus_123', {
          metadata: { storage_used: expected },
        });
      });

      it('uses currentStorageBytes (latest sample), not the average', async () => {
        // Two samples: average is 750 GB, latest snapshot is 1.5 TB
        mockGetTenantUsageMetrics.mockResolvedValue({
          storage: [
            { timestamp: '2024-01-01T00:00:00Z', bytesUsed: 0 },
            { timestamp: '2024-01-01T01:00:00Z', bytesUsed: 1_500_000_000_000 },
          ],
          egress: [],
        });

        await handler({ ...basePayload, orgName: undefined });

        expect(mockCustomersUpdate).toHaveBeenCalledWith('cus_123', {
          metadata: { storage_used: '1.5 TB' },
        });
      });

      it('reports "0 B" when org name present and storage is zero', async () => {
        mockGetTenantUsageMetrics.mockResolvedValue({ storage: [], egress: [] });

        await handler(basePayload); // basePayload has orgName: 'Acme Corp'

        expect(mockCustomersUpdate).toHaveBeenCalledOnce();
        expect(mockCustomersUpdate).toHaveBeenCalledWith('cus_123', {
          metadata: {
            storage_used: '0 B',
            organization_name: 'Acme Corp',
          },
        });
      });
    });
  });

  // -----------------------------------------------------------------------
  // Multi-region
  // -----------------------------------------------------------------------
  describe('multi-region', () => {
    const t = '2024-01-01T00:00:00Z';

    it('FTH-only trial org under limits: probes FTH, no status change, lockAction active', async () => {
      const fthOnlyPayload: UsageReportingWorkerPayload = {
        ...basePayload,
        subscriptionStatus: 'trialing',
      };
      mockAuroraIsTenantReady.mockReturnValue(null);
      mockFthIsTenantReady.mockReturnValue('fth-client-9');
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: t, bytesUsed: 500_000_000_000 }],
        egress: [{ timestamp: t, bytesUsed: 100_000_000_000 }],
      });

      await handler(fthOnlyPayload);

      expect(mockFthGetTenantStatus).toHaveBeenCalledWith('fth-client-9');
      expect(mockFthUpdateTenantStatus).not.toHaveBeenCalled();

      // Stripe meter must still be emitted
      expect(mockMeterEventsCreate).toHaveBeenCalledOnce();

      // Audit record must exist
      const putCalls = ddbMock.commandCalls(PutItemCommand);
      expect(putCalls).toHaveLength(1);
      const item = putCalls[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'active' });
    });

    it('FTH-only trial org over the storage limit gets write-locked via the FTH orchestrator', async () => {
      const fthOnlyPayload: UsageReportingWorkerPayload = {
        ...basePayload,
        subscriptionStatus: 'trialing',
      };
      mockAuroraIsTenantReady.mockReturnValue(null);
      mockFthIsTenantReady.mockReturnValue('fth-client-9');
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: t, bytesUsed: 1_500_000_000_000 }], // 1.5 TB
        egress: [],
      });

      await handler(fthOnlyPayload);

      expect(mockFthUpdateTenantStatus).toHaveBeenCalledWith('fth-client-9', 'write-locked');
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'write-locked' });
    });

    it('trial org in both regions: only the out-of-sync region is updated', async () => {
      const trialPayload: UsageReportingWorkerPayload = {
        ...basePayload,
        subscriptionStatus: 'trialing',
      };
      mockFthIsTenantReady.mockReturnValue('fth-client-9');
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: t, bytesUsed: 1_500_000_000_000 }], // over limit per region sum
        egress: [],
      });
      // Aurora was already locked by a previous run; FTH still active.
      mockAuroraGetTenantStatus.mockResolvedValue({ kind: 'ok', status: 'write-locked' });
      mockFthGetTenantStatus.mockResolvedValue({ kind: 'ok', status: 'active' });

      await handler(trialPayload);

      expect(mockAuroraUpdateTenantStatus).not.toHaveBeenCalled();
      expect(mockFthUpdateTenantStatus).toHaveBeenCalledWith('fth-client-9', 'write-locked');
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'write-locked' });
    });

    it('partial failure: Aurora locks but FTH update fails — lockAction error:sync-failed:fth, report still completes', async () => {
      const trialPayload: UsageReportingWorkerPayload = {
        ...basePayload,
        subscriptionStatus: 'trialing',
      };
      mockFthIsTenantReady.mockReturnValue('fth-client-9');
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: t, bytesUsed: 1_500_000_000_000 }],
        egress: [],
      });
      mockFthUpdateTenantStatus.mockRejectedValue(new Error('FTH API down'));

      await handler(trialPayload);

      expect(mockAuroraUpdateTenantStatus).toHaveBeenCalledWith(
        'aurora-tenant-123',
        'write-locked',
      );
      expect(mockMeterEventsCreate).toHaveBeenCalledOnce();
      const putCalls = ddbMock.commandCalls(PutItemCommand);
      expect(putCalls).toHaveLength(1);
      const item = putCalls[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'error:sync-failed:fth' });
    });

    it('persistent probe error in one region: the other region is still synced', async () => {
      vi.useFakeTimers();
      const trialPayload: UsageReportingWorkerPayload = {
        ...basePayload,
        subscriptionStatus: 'trialing',
      };
      mockFthIsTenantReady.mockReturnValue('fth-client-9');
      mockGetTenantUsageMetrics.mockResolvedValue({
        storage: [{ timestamp: t, bytesUsed: 1_500_000_000_000 }],
        egress: [],
      });
      mockAuroraGetTenantStatus.mockResolvedValue({ kind: 'error', cause: new Error('outage') });

      const promise = handler(trialPayload);
      await vi.runAllTimersAsync();
      await promise;

      expect(mockFthUpdateTenantStatus).toHaveBeenCalledWith('fth-client-9', 'write-locked');
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
      expect(item.lockAction).toEqual({ S: 'error:sync-failed:aurora' });
      vi.useRealTimers();
    });

    it('both regions: getTenantUsageMetrics called twice, Stripe value is sum in GB', async () => {
      const bothPayload: UsageReportingWorkerPayload = {
        ...basePayload,
        subscriptionStatus: 'active',
      };
      mockFthIsTenantReady.mockReturnValue('fth-client-9');

      mockGetTenantUsageMetrics.mockImplementation((tenantId: string) => {
        if (tenantId === 'aurora-tenant-123') {
          return Promise.resolve({
            storage: [{ timestamp: t, bytesUsed: 1_000_000_000_000 }],
            egress: [],
          });
        }
        // fth-client-9
        return Promise.resolve({
          storage: [{ timestamp: t, bytesUsed: 500_000_000_000 }],
          egress: [],
        });
      });

      await handler(bothPayload);

      // Must have fetched metrics for each region
      expect(mockGetTenantUsageMetrics).toHaveBeenCalledTimes(2);
      expect(mockGetTenantUsageMetrics).toHaveBeenCalledWith(
        'aurora-tenant-123',
        expect.objectContaining({ interval: '1d' }),
      );
      expect(mockGetTenantUsageMetrics).toHaveBeenCalledWith(
        'fth-client-9',
        expect.objectContaining({ interval: '1d' }),
      );

      // Stripe meter value should be the sum: 1 TB + 500 GB = 1500 GB → '1500'
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ value: '1500' }),
        }),
      );

      const putCalls = ddbMock.commandCalls(PutItemCommand);
      expect(putCalls).toHaveLength(1);
      const record = unmarshall(putCalls[0].args[0].input.Item!);

      // Aggregate averageStorageBytesUsed is the sum across both regions
      // aurora: 1 TB average (single sample), fth: 500 GB average (single sample) → 1.5 TB
      expect(record.averageStorageBytesUsed).toBe(1_500_000_000_000);
    });

    it('both regions with misaligned series: storage average is the carry-forward merge, not the sum of per-region means', async () => {
      const bothPayload: UsageReportingWorkerPayload = {
        ...basePayload,
        subscriptionStatus: 'active',
      };
      mockFthIsTenantReady.mockReturnValue('fth-client-9');

      const t0 = '2024-01-01T00:00:00Z';
      const t1 = '2024-01-01T01:00:00Z';
      mockGetTenantUsageMetrics.mockImplementation((tenantId: string) => {
        if (tenantId === 'aurora-tenant-123') {
          // Steady at 2000 across the whole period.
          return Promise.resolve({
            storage: [
              { timestamp: t0, bytesUsed: 2000 },
              { timestamp: t1, bytesUsed: 2000 },
            ],
            egress: [],
          });
        }
        // fth-client-9: newly provisioned, only reports at t1.
        return Promise.resolve({
          storage: [{ timestamp: t1, bytesUsed: 4000 }],
          egress: [],
        });
      });

      await handler(bothPayload);

      const putCalls = ddbMock.commandCalls(PutItemCommand);
      const record = unmarshall(putCalls[0].args[0].input.Item!);

      // Carry-forward merge: t0 = 2000 + 0, t1 = 2000 + 4000 → avg (2000 + 6000) / 2 = 4000.
      // Summing per-region means would have wrongly billed 2000 + 4000 = 6000.
      expect(record.averageStorageBytesUsed).toBe(4000);
    });

    it('no ready tenant in any region: returns without reporting or writing an audit', async () => {
      mockAuroraIsTenantReady.mockReturnValue(null);
      mockFthIsTenantReady.mockReturnValue(null);

      await expect(handler(basePayload)).resolves.toBeUndefined();

      expect(mockGetTenantUsageMetrics).not.toHaveBeenCalled();
      expect(mockMeterEventsCreate).not.toHaveBeenCalled();
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    });
  });
});
