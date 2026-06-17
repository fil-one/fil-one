import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { SubscriptionStatus } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

// The drift-checker probes every available orchestrator through the registry.
// Mocking getAvailableOrchestrators lets us drive fake orchestrators end-to-end.
const mockGetAvailableOrchestrators = vi.fn();
vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: (...args: unknown[]) => mockGetAvailableOrchestrators(...args),
}));

const mockReportMetric = vi.fn();
vi.mock('../lib/metrics.js', () => ({
  reportMetric: (...args: unknown[]) => mockReportMetric(...args),
}));

vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
}));

process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);

import { handler } from './subscription-drift-checker.js';
import { fakeOrchestrator, type FakeOrchestrator } from '../test/fake-orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-abc';
const ORG_ID = 'org-xyz';

function activeBillingItem(orgId = ORG_ID, userId = USER_ID) {
  return marshall({
    pk: `CUSTOMER#${userId}`,
    sk: 'SUBSCRIPTION',
    orgId,
    subscriptionStatus: SubscriptionStatus.Active,
  });
}

function emissionFor(orchestratorId: string) {
  return mockReportMetric.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find((e) => e.orchestrator === orchestratorId);
}

function outOfSyncLogs(spy: ReturnType<typeof vi.spyOn>) {
  const calls = spy.mock.calls as unknown as unknown[][];
  return calls.filter((c) => c[0] === '[subscription-drift-checker] out_of_sync');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subscription-drift-checker', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let aurora: FakeOrchestrator;

  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    aurora = fakeOrchestrator('aurora');
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('emits zero counters when billing table is empty', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler();

    expect(emissionFor('aurora')).toMatchObject({
      SubscriptionsTotal: 0,
      SubscriptionsNotInSync: 0,
      SubscriptionsMissingTenant: 0,
      SubscriptionsProbeFailed: 0,
    });
    expect(aurora.getTenantStatus).not.toHaveBeenCalled();
    expect(outOfSyncLogs(logSpy)).toHaveLength(0);
  });

  it('emits no out_of_sync log when the tenant is active', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
    aurora.getTenantStatus.mockResolvedValue({ kind: 'ok', status: 'active' });

    await handler();

    expect(outOfSyncLogs(logSpy)).toHaveLength(0);
    expect(emissionFor('aurora')).toMatchObject({
      SubscriptionsTotal: 1,
      SubscriptionsTenantsChecked: 1,
      SubscriptionsNotInSync: 0,
      SubscriptionsMissingTenant: 0,
      SubscriptionsProbeFailed: 0,
    });
  });

  it.each([
    ['write-locked', { kind: 'ok', status: 'write-locked' }, 'write-locked'],
    ['disabled', { kind: 'ok', status: 'disabled' }, 'disabled'],
    ['unmodeled status', { kind: 'ok', status: undefined }, 'unknown'],
    ['not_found', { kind: 'not_found' }, 'not_found'],
  ])(
    'logs out_of_sync and increments counter when the tenant is %s',
    async (_label, probe, expectedStatus) => {
      ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
      aurora.getTenantStatus.mockResolvedValue(probe);

      await handler();

      const logs = outOfSyncLogs(logSpy);
      expect(logs).toHaveLength(1);
      expect(logs[0][1]).toMatchObject({
        orgId: ORG_ID,
        userId: USER_ID,
        orchestrator: 'aurora',
        tenantId: `aurora:${ORG_ID}`,
        status: expectedStatus,
      });
      expect(emissionFor('aurora')).toMatchObject({
        SubscriptionsNotInSync: 1,
        SubscriptionsMissingTenant: 0,
        SubscriptionsProbeFailed: 0,
      });
    },
  );

  it('counts probe failures when the orchestrator returns an error result', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
    aurora.getTenantStatus.mockResolvedValue({ kind: 'error', cause: new Error('boom') });

    await handler();

    expect(outOfSyncLogs(logSpy)).toHaveLength(0);
    expect(emissionFor('aurora')).toMatchObject({
      SubscriptionsNotInSync: 0,
      SubscriptionsMissingTenant: 0,
      SubscriptionsProbeFailed: 1,
    });
  });

  it('counts the org as missing a tenant when the orchestrator has none', async () => {
    aurora = fakeOrchestrator('aurora', { ready: false });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);
    ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });

    await handler();

    expect(aurora.getTenantStatus).not.toHaveBeenCalled();
    expect(outOfSyncLogs(logSpy)).toHaveLength(0);
    expect(emissionFor('aurora')).toMatchObject({
      SubscriptionsTotal: 1,
      SubscriptionsMissingTenant: 1,
      SubscriptionsTenantsChecked: 0,
      SubscriptionsNotInSync: 0,
      SubscriptionsProbeFailed: 0,
    });
  });

  it('counts probe failure when getTenantStatus throws and continues processing', async () => {
    const orgId2 = 'org-second';
    ddbMock.on(ScanCommand).resolves({
      Items: [activeBillingItem(), activeBillingItem(orgId2, 'user-second')],
    });
    aurora.getTenantStatus
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ kind: 'ok', status: 'active' });

    await handler();

    expect(outOfSyncLogs(logSpy)).toHaveLength(0);
    expect(emissionFor('aurora')).toMatchObject({
      SubscriptionsTotal: 2,
      SubscriptionsNotInSync: 0,
      SubscriptionsMissingTenant: 0,
      SubscriptionsProbeFailed: 1,
    });
  });

  it('dedupes multiple billing records for the same orgId and probes once', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        activeBillingItem(ORG_ID, 'user-first'),
        activeBillingItem(ORG_ID, 'user-second'),
        activeBillingItem(ORG_ID, 'user-third'),
      ],
    });
    aurora.getTenantStatus.mockResolvedValue({ kind: 'ok', status: 'disabled' });

    await handler();

    expect(aurora.getTenantStatus).toHaveBeenCalledTimes(1);
    const logs = outOfSyncLogs(logSpy);
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({
      orgId: ORG_ID,
      userId: 'user-first', // first-seen userId becomes the representative
      orchestrator: 'aurora',
      status: 'disabled',
    });
    expect(emissionFor('aurora')).toMatchObject({
      SubscriptionsTotal: 1,
      SubscriptionsNotInSync: 1,
    });
  });

  it('handles paginated scan results', async () => {
    const orgIdPage2 = 'org-page2';
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [activeBillingItem()],
        LastEvaluatedKey: { pk: { S: 'cursor' }, sk: { S: 'val' } },
      })
      .resolvesOnce({ Items: [activeBillingItem(orgIdPage2, 'user-page2')] });

    aurora.getTenantStatus
      .mockResolvedValueOnce({ kind: 'ok', status: 'active' })
      .mockResolvedValueOnce({ kind: 'ok', status: 'write-locked' });

    await handler();

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    const logs = outOfSyncLogs(logSpy);
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({ orgId: orgIdPage2 });
    expect(emissionFor('aurora')).toMatchObject({
      SubscriptionsTotal: 2,
      SubscriptionsNotInSync: 1,
    });
  });

  it('logs a warn and skips records without orgId', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        marshall({
          pk: `CUSTOMER#${USER_ID}`,
          sk: 'SUBSCRIPTION',
          subscriptionStatus: SubscriptionStatus.Active,
        }),
      ],
    });

    await handler();

    expect(aurora.getTenantStatus).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[subscription-drift-checker] missing orgId',
      expect.objectContaining({ pk: `CUSTOMER#${USER_ID}` }),
    );
    expect(emissionFor('aurora')).toMatchObject({ SubscriptionsTotal: 0 });
  });

  // -----------------------------------------------------------------------
  // Multi-orchestrator
  // -----------------------------------------------------------------------
  it('reports a per-orchestrator missing tenant (Aurora ready, no FTH tenant)', async () => {
    const fth = fakeOrchestrator('fth', { ready: false });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);
    ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
    aurora.getTenantStatus.mockResolvedValue({ kind: 'ok', status: 'active' });

    await handler();

    expect(emissionFor('aurora')).toMatchObject({
      SubscriptionsTotal: 1,
      SubscriptionsTenantsChecked: 1,
      SubscriptionsMissingTenant: 0,
      SubscriptionsNotInSync: 0,
    });
    expect(emissionFor('fth')).toMatchObject({
      SubscriptionsTotal: 1,
      SubscriptionsTenantsChecked: 0,
      SubscriptionsMissingTenant: 1,
      SubscriptionsNotInSync: 0,
    });
  });

  it('detects drift on FTH while Aurora is in sync', async () => {
    const fth = fakeOrchestrator('fth', { status: 'write-locked' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);
    ddbMock.on(ScanCommand).resolves({ Items: [activeBillingItem()] });
    aurora.getTenantStatus.mockResolvedValue({ kind: 'ok', status: 'active' });

    await handler();

    expect(emissionFor('aurora')).toMatchObject({ SubscriptionsNotInSync: 0 });
    expect(emissionFor('fth')).toMatchObject({ SubscriptionsNotInSync: 1 });
    const logs = outOfSyncLogs(logSpy);
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({ orchestrator: 'fth', status: 'write-locked' });
  });
});
