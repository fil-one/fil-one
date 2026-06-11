import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetAvailableOrchestrators = vi.fn();
vi.mock('./service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: (...args: unknown[]) => mockGetAvailableOrchestrators(...args),
}));

process.env.FILONE_STAGE = 'test';

import {
  getProvisionedRegions,
  setTenantStatusInProvisionedRegions,
  syncTenantStatusInProvisionedRegions,
} from './region-helpers.js';

function fakeOrchestrator(id: string, tenantId: string | null, status = 'active') {
  return {
    id,
    isTenantReady: vi.fn().mockResolvedValue(tenantId),
    updateTenantStatus: vi.fn().mockResolvedValue(undefined),
    getTenantStatus: vi.fn().mockResolvedValue({ kind: 'ok', status }),
  };
}

describe('setTenantStatusInProvisionedRegions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the available orchestrators for the current stage', async () => {
    mockGetAvailableOrchestrators.mockReturnValue([]);

    await setTenantStatusInProvisionedRegions('org-1', 'active');

    expect(mockGetAvailableOrchestrators).toHaveBeenCalledWith('test');
  });

  it('updates the status in each provisioned region', async () => {
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1');
    const fth = fakeOrchestrator('fth', 'fth-t-1');
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    await setTenantStatusInProvisionedRegions('org-1', 'write-locked');

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith('aurora-t-1', 'write-locked');
    expect(fth.updateTenantStatus).toHaveBeenCalledWith('fth-t-1', 'write-locked');
  });

  it('resolves the tenant per orchestrator via isTenantReady', async () => {
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1');
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await setTenantStatusInProvisionedRegions('org-1', 'active');

    expect(aurora.isTenantReady).toHaveBeenCalledWith('org-1');
  });

  it('skips regions whose tenant is not provisioned', async () => {
    const fth = fakeOrchestrator('fth', null);
    mockGetAvailableOrchestrators.mockReturnValue([fth]);

    await setTenantStatusInProvisionedRegions('org-1', 'disabled');

    expect(fth.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('propagates errors from updateTenantStatus', async () => {
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1');
    aurora.updateTenantStatus.mockRejectedValue(new Error('Aurora API error'));
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await expect(setTenantStatusInProvisionedRegions('org-1', 'active')).rejects.toThrow(
      'Aurora API error',
    );
  });
});

describe('syncTenantStatusInProvisionedRegions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates a region whose status differs from the desired status', async () => {
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1', 'active');
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'write-locked');

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith('aurora-t-1', 'write-locked');
  });

  it('skips the update when the region status already matches', async () => {
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1', 'write-locked');
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'write-locked');

    expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('returns per-region outcomes distinguishing in-sync from updated regions', async () => {
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1', 'write-locked');
    const fth = fakeOrchestrator('fth', 'fth-t-1', 'active');
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const result = await syncTenantStatusInProvisionedRegions('org-1', 'write-locked');

    expect(result).toEqual([
      { orchestratorId: 'aurora', tenantId: 'aurora-t-1', outcome: 'in-sync' },
      { orchestratorId: 'fth', tenantId: 'fth-t-1', outcome: 'updated' },
    ]);
  });

  it('reports a not-found tenant without updating it', async () => {
    const fth = fakeOrchestrator('fth', 'fth-t-1');
    fth.getTenantStatus.mockResolvedValue({ kind: 'not_found' });
    mockGetAvailableOrchestrators.mockReturnValue([fth]);

    const result = await syncTenantStatusInProvisionedRegions('org-1', 'disabled');

    expect(result).toEqual([{ orchestratorId: 'fth', tenantId: 'fth-t-1', outcome: 'not-found' }]);
  });

  it('does not call updateTenantStatus for a not-found tenant', async () => {
    const fth = fakeOrchestrator('fth', 'fth-t-1');
    fth.getTenantStatus.mockResolvedValue({ kind: 'not_found' });
    mockGetAvailableOrchestrators.mockReturnValue([fth]);

    await syncTenantStatusInProvisionedRegions('org-1', 'disabled');

    expect(fth.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('retries a transient probe error and syncs the region', async () => {
    vi.useFakeTimers();
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1');
    aurora.getTenantStatus
      .mockResolvedValueOnce({ kind: 'error', cause: new Error('transient outage') })
      .mockResolvedValueOnce({ kind: 'error', cause: new Error('transient outage') })
      .mockResolvedValue({ kind: 'ok', status: 'active' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const promise = syncTenantStatusInProvisionedRegions('org-1', 'write-locked');
    await vi.runAllTimersAsync();
    await promise;

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith('aurora-t-1', 'write-locked');
    vi.useRealTimers();
  });

  it('returns an error outcome when the probe keeps failing past all retries (1 initial + 3 retries)', async () => {
    vi.useFakeTimers();
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1');
    aurora.getTenantStatus.mockResolvedValue({ kind: 'error', cause: new Error('outage') });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const promise = syncTenantStatusInProvisionedRegions('org-1', 'write-locked');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toMatchObject([
      { orchestratorId: 'aurora', tenantId: 'aurora-t-1', outcome: 'error' },
    ]);
    expect(aurora.getTenantStatus).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('still syncs the other region when one probe keeps failing', async () => {
    vi.useFakeTimers();
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1');
    aurora.getTenantStatus.mockResolvedValue({ kind: 'error', cause: new Error('outage') });
    const fth = fakeOrchestrator('fth', 'fth-t-1', 'active');
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const promise = syncTenantStatusInProvisionedRegions('org-1', 'write-locked');
    await vi.runAllTimersAsync();
    await promise;

    expect(fth.updateTenantStatus).toHaveBeenCalledWith('fth-t-1', 'write-locked');
    vi.useRealTimers();
  });

  it('returns an error outcome with the cause when updateTenantStatus rejects', async () => {
    const updateError = new Error('FTH API error');
    const fth = fakeOrchestrator('fth', 'fth-t-1', 'active');
    fth.updateTenantStatus.mockRejectedValue(updateError);
    mockGetAvailableOrchestrators.mockReturnValue([fth]);

    const result = await syncTenantStatusInProvisionedRegions('org-1', 'write-locked');

    expect(result).toEqual([
      { orchestratorId: 'fth', tenantId: 'fth-t-1', outcome: 'error', cause: updateError },
    ]);
  });
});

describe('getProvisionedRegions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the available orchestrators for the current stage', async () => {
    mockGetAvailableOrchestrators.mockReturnValue([]);

    await getProvisionedRegions('org-1');

    expect(mockGetAvailableOrchestrators).toHaveBeenCalledWith('test');
  });

  it('returns each provisioned region as an orchestrator paired with its tenant', async () => {
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1');
    const fth = fakeOrchestrator('fth', 'fth-t-1');
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const result = await getProvisionedRegions('org-1');

    expect(result).toEqual([
      { orchestrator: aurora, tenantId: 'aurora-t-1' },
      { orchestrator: fth, tenantId: 'fth-t-1' },
    ]);
  });

  it('omits regions whose tenant is not provisioned', async () => {
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1');
    const fth = fakeOrchestrator('fth', null);
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const result = await getProvisionedRegions('org-1');

    expect(result).toEqual([{ orchestrator: aurora, tenantId: 'aurora-t-1' }]);
  });

  it('returns an empty array when no region is provisioned', async () => {
    const aurora = fakeOrchestrator('aurora', null);
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const result = await getProvisionedRegions('org-1');

    expect(result).toEqual([]);
  });
});
