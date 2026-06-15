import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
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

// grace-period-enforcer probes/locks tenants through the orchestrator registry
// (via lib/region-helpers.js, which is left real). Mocking getAvailableOrchestrators
// lets us drive fake orchestrators end-to-end.
const mockGetAvailableOrchestrators = vi.fn();
vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: (...args: unknown[]) => mockGetAvailableOrchestrators(...args),
}));

vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
}));

process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);

import { handler } from './grace-period-enforcer.js';
import {
  fakeOrchestrator,
  tenantFor as fakeTenantFor,
  type FakeOrchestrator,
} from '../test/fake-orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_USER_ID = 'user-123';
const MOCK_ORG_ID = 'org-456';

const tenantFor = (orchestratorId: string, orgId = MOCK_ORG_ID) =>
  fakeTenantFor(orchestratorId, orgId);

function pastDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function futureDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

function buildBillingItem(overrides: Record<string, unknown>) {
  return marshall({
    pk: `CUSTOMER#${MOCK_USER_ID}`,
    sk: 'SUBSCRIPTION',
    orgId: MOCK_ORG_ID,
    ...overrides,
  });
}

function canceledUpdate() {
  return ddbMock
    .commandCalls(UpdateItemCommand)
    .find(
      (c) =>
        c.args[0].input.ExpressionAttributeValues?.[':status']?.S === SubscriptionStatus.Canceled,
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('grace-period-enforcer', () => {
  let aurora: FakeOrchestrator;

  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(UpdateItemCommand).resolves({});
    vi.clearAllMocks();
    aurora = fakeOrchestrator('aurora');
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // No-op
  // -----------------------------------------------------------------------
  it('does nothing when no records found', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler();

    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Expired grace_period → canceled + disabled
  // -----------------------------------------------------------------------
  it('transitions expired grace_period to canceled', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: pastDate(1),
        }),
      ],
    });

    await handler();

    expect(canceledUpdate()).toBeDefined();
  });

  it('disables the tenant in every provisioned region when grace expired', async () => {
    const fth = fakeOrchestrator('fth');
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: pastDate(1),
        }),
      ],
    });

    await handler();

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith(tenantFor('aurora'), 'disabled');
    expect(fth.updateTenantStatus).toHaveBeenCalledWith(tenantFor('fth'), 'disabled');
  });

  it('does not cancel the subscription when the disable fails in one region', async () => {
    const fth = fakeOrchestrator('fth');
    fth.updateTenantStatus.mockRejectedValue(new Error('FTH API error'));
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: pastDate(1),
        }),
      ],
    });

    await handler();

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith(tenantFor('aurora'), 'disabled');
    expect(canceledUpdate()).toBeUndefined();
  });

  it('retries only the failed region on the next run, then cancels', async () => {
    const fth = fakeOrchestrator('fth');
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: pastDate(1),
        }),
      ],
    });

    // First run: FTH disable fails; the record stays in grace_period.
    // Second run: Aurora probes as already disabled, FTH succeeds.
    fth.updateTenantStatus
      .mockRejectedValueOnce(new Error('FTH API error'))
      .mockResolvedValue(undefined);
    aurora.getTenantStatus
      .mockResolvedValueOnce({ kind: 'ok', status: 'active' })
      .mockResolvedValue({ kind: 'ok', status: 'disabled' });

    await handler();
    expect(canceledUpdate()).toBeUndefined();

    await handler();

    expect(aurora.updateTenantStatus).toHaveBeenCalledTimes(1);
    expect(fth.updateTenantStatus).toHaveBeenCalledTimes(2);
    expect(canceledUpdate()).toBeDefined();
  });

  it('cancels without a disable call when the tenant is already disabled', async () => {
    aurora = fakeOrchestrator('aurora', { status: 'disabled' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: pastDate(1),
        }),
      ],
    });

    await handler();

    expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
    expect(canceledUpdate()).toBeDefined();
  });

  it('cancels the subscription even when no region is provisioned', async () => {
    aurora = fakeOrchestrator('aurora', { ready: false });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: pastDate(1),
        }),
      ],
    });

    await handler();

    expect(canceledUpdate()).toBeDefined();
    expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Non-expired grace_period → write-lock retry
  // -----------------------------------------------------------------------
  it('write-locks a non-expired grace_period tenant reported as active', async () => {
    aurora = fakeOrchestrator('aurora', { status: 'active' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: futureDate(5),
        }),
      ],
    });

    await handler();

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith(tenantFor('aurora'), 'write-locked');
  });

  it('write-locks when the orchestrator reports an unmodeled (undefined) status', async () => {
    aurora.getTenantStatus.mockResolvedValue({ kind: 'ok', status: undefined });
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: futureDate(5),
        }),
      ],
    });

    await handler();

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith(tenantFor('aurora'), 'write-locked');
  });

  it('skips write-lock when the tenant is already write-locked', async () => {
    aurora = fakeOrchestrator('aurora', { status: 'write-locked' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: futureDate(5),
        }),
      ],
    });

    await handler();

    expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('skips write-lock when the tenant is disabled (never downgrade)', async () => {
    aurora = fakeOrchestrator('aurora', { status: 'disabled' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: futureDate(5),
        }),
      ],
    });

    await handler();

    expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('skips write-lock when the orchestrator reports the tenant is not found', async () => {
    aurora.getTenantStatus.mockResolvedValue({ kind: 'not_found' });
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: futureDate(5),
        }),
      ],
    });

    await handler();

    expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('does not write-lock when the live status probe errors', async () => {
    // Fake timers skip over the probe-retry backoff delays.
    vi.useFakeTimers();
    aurora.getTenantStatus.mockResolvedValue({ kind: 'error', cause: new Error('boom') });
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: futureDate(5),
        }),
      ],
    });

    const promise = handler();
    await vi.runAllTimersAsync();
    await promise;

    expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('write-locks only the regions that are not already locked', async () => {
    aurora = fakeOrchestrator('aurora', { status: 'write-locked' });
    const fth = fakeOrchestrator('fth', { status: 'active' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);
    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: futureDate(5),
        }),
      ],
    });

    await handler();

    expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
    expect(fth.updateTenantStatus).toHaveBeenCalledWith(tenantFor('fth'), 'write-locked');
  });

  // -----------------------------------------------------------------------
  // Resilience
  // -----------------------------------------------------------------------
  it('continues processing other records when one fails', async () => {
    const userId2 = 'user-second';
    const orgId2 = 'org-second';

    ddbMock.on(ScanCommand).resolves({
      Items: [
        buildBillingItem({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: pastDate(1),
        }),
        marshall({
          pk: `CUSTOMER#${userId2}`,
          sk: 'SUBSCRIPTION',
          orgId: orgId2,
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: pastDate(2),
        }),
      ],
    });

    // First record: billing cancel write fails.
    ddbMock
      .on(UpdateItemCommand, {
        Key: { pk: { S: `CUSTOMER#${MOCK_USER_ID}` }, sk: { S: 'SUBSCRIPTION' } },
      })
      .rejects(new Error('DynamoDB error'));
    // Second record: succeeds.
    ddbMock
      .on(UpdateItemCommand, {
        Key: { pk: { S: `CUSTOMER#${userId2}` }, sk: { S: 'SUBSCRIPTION' } },
      })
      .resolves({});

    await handler();

    // Second record still disabled + canceled.
    expect(aurora.updateTenantStatus).toHaveBeenCalledWith(tenantFor('aurora', orgId2), 'disabled');
    expect(
      ddbMock
        .commandCalls(UpdateItemCommand)
        .some((c) => c.args[0].input.Key?.pk?.S === `CUSTOMER#${userId2}`),
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  it('skips records with missing orgId', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        marshall({
          pk: `CUSTOMER#${MOCK_USER_ID}`,
          sk: 'SUBSCRIPTION',
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: pastDate(1),
        }),
      ],
    });

    await handler();

    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('handles paginated scan results', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [
          buildBillingItem({
            subscriptionStatus: SubscriptionStatus.GracePeriod,
            gracePeriodEndsAt: pastDate(1),
          }),
        ],
        LastEvaluatedKey: { pk: { S: 'cursor' }, sk: { S: 'val' } },
      })
      .resolvesOnce({ Items: [] });

    await handler();

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
    expect(aurora.updateTenantStatus).toHaveBeenCalledWith(tenantFor('aurora'), 'disabled');
  });

  // -----------------------------------------------------------------------
  // Idempotency — running twice
  // -----------------------------------------------------------------------
  describe('idempotency — running twice', () => {
    it('expired grace period — second run finds no candidates after first run canceled', async () => {
      ddbMock
        .on(ScanCommand)
        .resolvesOnce({
          Items: [
            buildBillingItem({
              subscriptionStatus: SubscriptionStatus.GracePeriod,
              gracePeriodEndsAt: pastDate(1),
            }),
          ],
        })
        .resolvesOnce({ Items: [] });

      await handler();
      await handler();

      // Disable called only on the first run.
      expect(aurora.updateTenantStatus).toHaveBeenCalledTimes(1);
      expect(aurora.updateTenantStatus).toHaveBeenCalledWith(tenantFor('aurora'), 'disabled');
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
    });

    it('non-expired grace period — second run skips write_lock once already write-locked', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          buildBillingItem({
            subscriptionStatus: SubscriptionStatus.GracePeriod,
            gracePeriodEndsAt: futureDate(5),
          }),
        ],
      });

      // First run: active → triggers write-lock. Second run: already write-locked → skipped.
      aurora.getTenantStatus
        .mockResolvedValueOnce({ kind: 'ok', status: 'active' })
        .mockResolvedValueOnce({ kind: 'ok', status: 'write-locked' });

      await handler();
      await handler();

      expect(aurora.updateTenantStatus).toHaveBeenCalledTimes(1);
    });
  });
});
