import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetAvailableOrchestrators = vi.fn();
vi.mock('./service-orchestrator-registry.ts', () => ({
  getAvailableOrchestrators: (...args: unknown[]) => mockGetAvailableOrchestrators(...args),
}));

const mockGetOrgProfile = vi.fn(async (orgId: string) => fakeOrgProfile(orgId));
vi.mock('./org-profile.ts', () => ({
  getOrgProfile: (...args: unknown[]) => mockGetOrgProfile(...(args as [string])),
}));

process.env.FILONE_STAGE = 'test';

import {
  assertRegionSyncSucceeded,
  getProvisionedRegions,
  syncTenantStatusInProvisionedRegions,
  WEBHOOK_STATUS_SYNC_RETRY,
  type RegionSyncOutcome,
} from './region-helpers.ts';
import { fakeOrchestrator, fakeOrgProfile } from '../test/fake-orchestrator.ts';

/** A caller deadline that never expires, for the tests that are not about one. */
const neverAborts = (): AbortSignal => new AbortController().signal;

describe('syncTenantStatusInProvisionedRegions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates a region whose status differs from the desired status', async () => {
    const aurora = fakeOrchestrator('aurora', { status: 'active' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'write-locked', { signal: neverAborts() });

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith(
      'aurora:org-1',
      'write-locked',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('skips the update when the region status already matches', async () => {
    const aurora = fakeOrchestrator('aurora', { status: 'write-locked' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'write-locked', { signal: neverAborts() });

    expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('returns per-region outcomes distinguishing in-sync from updated regions', async () => {
    const aurora = fakeOrchestrator('aurora', { status: 'write-locked' });
    const fth = fakeOrchestrator('fth', { status: 'active' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const result = await syncTenantStatusInProvisionedRegions('org-1', 'write-locked', {
      signal: neverAborts(),
    });

    expect(result).toEqual([
      { orchestratorId: 'aurora', tenantId: 'aurora:org-1', outcome: 'in-sync' },
      { orchestratorId: 'fth', tenantId: 'fth:org-1', outcome: 'updated' },
    ]);
  });

  it('reports a not-found tenant without updating it', async () => {
    const fth = fakeOrchestrator('fth');
    fth.getTenantStatus.mockResolvedValue({ kind: 'not_found' });
    mockGetAvailableOrchestrators.mockReturnValue([fth]);

    const result = await syncTenantStatusInProvisionedRegions('org-1', 'disabled', {
      signal: neverAborts(),
    });

    expect(result).toEqual([
      { orchestratorId: 'fth', tenantId: 'fth:org-1', outcome: 'not-found' },
    ]);
  });

  it('does not call updateTenantStatus for a not-found tenant', async () => {
    const fth = fakeOrchestrator('fth');
    fth.getTenantStatus.mockResolvedValue({ kind: 'not_found' });
    mockGetAvailableOrchestrators.mockReturnValue([fth]);

    await syncTenantStatusInProvisionedRegions('org-1', 'disabled', { signal: neverAborts() });

    expect(fth.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('never downgrades a disabled tenant to write-locked', async () => {
    const aurora = fakeOrchestrator('aurora', { status: 'disabled' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'write-locked', { signal: neverAborts() });

    expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('reports a skipped outcome for a disabled tenant left untouched', async () => {
    const aurora = fakeOrchestrator('aurora', { status: 'disabled' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const result = await syncTenantStatusInProvisionedRegions('org-1', 'write-locked', {
      signal: neverAborts(),
    });

    expect(result).toEqual([
      { orchestratorId: 'aurora', tenantId: 'aurora:org-1', outcome: 'skipped' },
    ]);
  });

  it('re-activates a disabled tenant when the desired status is active', async () => {
    const aurora = fakeOrchestrator('aurora', { status: 'disabled' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'active', { signal: neverAborts() });

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith(
      'aurora:org-1',
      'active',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('escalates a write-locked tenant to disabled', async () => {
    const aurora = fakeOrchestrator('aurora', { status: 'write-locked' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'disabled', { signal: neverAborts() });

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith(
      'aurora:org-1',
      'disabled',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('retries a transient probe error and syncs the region', async () => {
    vi.useFakeTimers();
    const aurora = fakeOrchestrator('aurora');
    aurora.getTenantStatus
      .mockResolvedValueOnce({ kind: 'error', cause: new Error('transient outage') })
      .mockResolvedValue({ kind: 'ok', status: 'active' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const promise = syncTenantStatusInProvisionedRegions('org-1', 'write-locked', {
      signal: neverAborts(),
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith(
      'aurora:org-1',
      'write-locked',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns an error outcome when the probe keeps failing past all retries (1 initial + 3 retries)', async () => {
    vi.useFakeTimers();
    const aurora = fakeOrchestrator('aurora');
    aurora.getTenantStatus.mockResolvedValue({ kind: 'error', cause: new Error('outage') });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const promise = syncTenantStatusInProvisionedRegions('org-1', 'write-locked', {
      signal: neverAborts(),
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject([
      { orchestratorId: 'aurora', tenantId: 'aurora:org-1', outcome: 'error' },
    ]);
    expect(aurora.getTenantStatus).toHaveBeenCalledTimes(4);
  });

  it('still syncs the other region when one probe keeps failing', async () => {
    vi.useFakeTimers();
    const aurora = fakeOrchestrator('aurora');
    aurora.getTenantStatus.mockResolvedValue({ kind: 'error', cause: new Error('outage') });
    const fth = fakeOrchestrator('fth', { status: 'active' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const promise = syncTenantStatusInProvisionedRegions('org-1', 'write-locked', {
      signal: neverAborts(),
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(fth.updateTenantStatus).toHaveBeenCalledWith(
      'fth:org-1',
      'write-locked',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns an error outcome with the cause when updateTenantStatus keeps failing past all retries (1 initial + 3 retries)', async () => {
    vi.useFakeTimers();
    const updateError = new Error('FTH API error');
    const fth = fakeOrchestrator('fth', { status: 'active' });
    fth.updateTenantStatus.mockRejectedValue(updateError);
    mockGetAvailableOrchestrators.mockReturnValue([fth]);

    const promise = syncTenantStatusInProvisionedRegions('org-1', 'write-locked', {
      signal: neverAborts(),
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual([
      { orchestratorId: 'fth', tenantId: 'fth:org-1', outcome: 'error', cause: updateError },
    ]);
    expect(fth.updateTenantStatus).toHaveBeenCalledTimes(4);
  });

  it('retries a transient update failure and syncs the region', async () => {
    vi.useFakeTimers();
    const fth = fakeOrchestrator('fth', { status: 'active' });
    fth.updateTenantStatus
      .mockRejectedValueOnce(new Error('transient outage'))
      .mockResolvedValue(undefined);
    mockGetAvailableOrchestrators.mockReturnValue([fth]);

    const promise = syncTenantStatusInProvisionedRegions('org-1', 'write-locked', {
      signal: neverAborts(),
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual([{ orchestratorId: 'fth', tenantId: 'fth:org-1', outcome: 'updated' }]);
  });

  it('stops retrying the probe once the caller deadline expires mid-flight', async () => {
    // Without the signal on pRetry this probe retries three more times, each
    // under a deadline of its own, and the sync outlives the caller's budget.
    const controller = new AbortController();
    const aurora = fakeOrchestrator('aurora');
    aurora.getTenantStatus.mockImplementation(async () => {
      controller.abort();
      return { kind: 'error' as const, cause: new Error('outage') };
    });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'write-locked', {
      signal: controller.signal,
    });

    expect(aurora.getTenantStatus).toHaveBeenCalledTimes(1);
  });

  it('reports an error outcome when the caller deadline has already expired', async () => {
    const aurora = fakeOrchestrator('aurora');
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const result = await syncTenantStatusInProvisionedRegions('org-1', 'write-locked', {
      signal: AbortSignal.abort(),
    });

    expect(result).toMatchObject([
      { orchestratorId: 'aurora', tenantId: 'aurora:org-1', outcome: 'error' },
    ]);
  });

  it('never calls the orchestrator when the caller deadline has already expired', async () => {
    const aurora = fakeOrchestrator('aurora');
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'write-locked', {
      signal: AbortSignal.abort(),
    });

    expect(aurora.getTenantStatus).not.toHaveBeenCalled();
  });

  it('passes the caller deadline to the status probe', async () => {
    const signal = neverAborts();
    const aurora = fakeOrchestrator('aurora', { status: 'active' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'write-locked', { signal });

    expect(aurora.getTenantStatus).toHaveBeenCalledWith('aurora:org-1', { signal });
  });

  it('passes the caller deadline to the status update', async () => {
    const signal = neverAborts();
    const aurora = fakeOrchestrator('aurora', { status: 'active' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'write-locked', { signal });

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith('aurora:org-1', 'write-locked', {
      signal,
    });
  });

  it('honors a tighter retry override (1 initial + 1 retry)', async () => {
    vi.useFakeTimers();
    const aurora = fakeOrchestrator('aurora');
    aurora.getTenantStatus.mockResolvedValue({ kind: 'error', cause: new Error('outage') });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const promise = syncTenantStatusInProvisionedRegions('org-1', 'write-locked', {
      retry: WEBHOOK_STATUS_SYNC_RETRY,
      signal: neverAborts(),
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(aurora.getTenantStatus).toHaveBeenCalledTimes(2);
  });
});

describe('assertRegionSyncSucceeded', () => {
  it('returns normally when no outcome is an error', () => {
    const outcomes: RegionSyncOutcome[] = [
      { orchestratorId: 'aurora', tenantId: 'aurora-t-1', outcome: 'updated' },
      { orchestratorId: 'fth', tenantId: 'fth-t-1', outcome: 'in-sync' },
    ];

    expect(() => assertRegionSyncSucceeded(outcomes)).not.toThrow();
  });

  it('returns normally for an empty outcome list', () => {
    expect(() => assertRegionSyncSucceeded([])).not.toThrow();
  });

  it('throws an error naming every failed orchestrator', () => {
    const outcomes: RegionSyncOutcome[] = [
      { orchestratorId: 'aurora', tenantId: 'aurora-t-1', outcome: 'error', cause: new Error('a') },
      { orchestratorId: 'fth', tenantId: 'fth-t-1', outcome: 'error', cause: new Error('b') },
    ];

    expect(() => assertRegionSyncSucceeded(outcomes)).toThrow(
      'tenant status sync failed for: aurora, fth',
    );
  });

  it('sets the cause from the first failed outcome', () => {
    const firstCause = new Error('Aurora API error');
    const outcomes: RegionSyncOutcome[] = [
      { orchestratorId: 'aurora', tenantId: 'aurora-t-1', outcome: 'error', cause: firstCause },
    ];

    let thrown: unknown;
    try {
      assertRegionSyncSucceeded(outcomes);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).cause).toBe(firstCause);
  });
});

describe('getProvisionedRegions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the available orchestrators', async () => {
    mockGetAvailableOrchestrators.mockReturnValue([]);

    await getProvisionedRegions('org-1');

    expect(mockGetAvailableOrchestrators).toHaveBeenCalledWith();
  });

  it('returns each provisioned region as an orchestrator paired with its tenant', async () => {
    const aurora = fakeOrchestrator('aurora');
    const fth = fakeOrchestrator('fth');
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const result = await getProvisionedRegions('org-1');

    expect(result).toEqual([
      { orchestrator: aurora, tenantId: 'aurora:org-1' },
      { orchestrator: fth, tenantId: 'fth:org-1' },
    ]);
  });

  it('omits regions whose tenant is not provisioned', async () => {
    const aurora = fakeOrchestrator('aurora');
    const fth = fakeOrchestrator('fth', { ready: false });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const result = await getProvisionedRegions('org-1');

    expect(result).toEqual([{ orchestrator: aurora, tenantId: 'aurora:org-1' }]);
  });

  it('returns an empty array when no region is provisioned', async () => {
    const aurora = fakeOrchestrator('aurora', { ready: false });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const result = await getProvisionedRegions('org-1');

    expect(result).toEqual([]);
  });

  it('fetches the PROFILE row once for all orchestrators', async () => {
    const aurora = fakeOrchestrator('aurora');
    const fth = fakeOrchestrator('fth');
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    await getProvisionedRegions('org-1');

    expect(mockGetOrgProfile).toHaveBeenCalledTimes(1);
    expect(mockGetOrgProfile).toHaveBeenCalledWith('org-1', undefined);
  });

  // Teardown snapshots tenant ids from here; a stale read would orphan a live
  // tenant permanently.
  it('passes the consistent-read option through to the PROFILE read', async () => {
    mockGetAvailableOrchestrators.mockReturnValue([fakeOrchestrator('aurora')]);

    await getProvisionedRegions('org-1', { consistent: true });

    expect(mockGetOrgProfile).toHaveBeenCalledWith('org-1', { consistentRead: true });
  });

  it('does not fetch the PROFILE row when no orchestrator is available', async () => {
    mockGetAvailableOrchestrators.mockReturnValue([]);

    await getProvisionedRegions('org-1');

    expect(mockGetOrgProfile).not.toHaveBeenCalled();
  });
});
