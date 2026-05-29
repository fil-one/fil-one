import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetAvailableOrchestrators = vi.fn();
vi.mock('./service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: (...args: unknown[]) => mockGetAvailableOrchestrators(...args),
}));

process.env.FILONE_STAGE = 'test';

import { resolveReadyTenants, setTenantStatusAcrossOrchestrators } from './tenant-status.js';

function fakeOrchestrator(id: string, tenantId: string | null) {
  return {
    id,
    isTenantReady: vi.fn().mockResolvedValue(tenantId),
    updateTenantStatus: vi.fn().mockResolvedValue(undefined),
  };
}

describe('setTenantStatusAcrossOrchestrators', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the available orchestrators for the current stage', async () => {
    mockGetAvailableOrchestrators.mockReturnValue([]);

    await setTenantStatusAcrossOrchestrators('org-1', 'active');

    expect(mockGetAvailableOrchestrators).toHaveBeenCalledWith('test');
  });

  it('updates the status on each orchestrator that has a tenant', async () => {
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1');
    const fth = fakeOrchestrator('fth', 'fth-t-1');
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    await setTenantStatusAcrossOrchestrators('org-1', 'write-locked');

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith('aurora-t-1', 'write-locked');
    expect(fth.updateTenantStatus).toHaveBeenCalledWith('fth-t-1', 'write-locked');
  });

  it('resolves the tenant per orchestrator via isTenantReady', async () => {
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1');
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await setTenantStatusAcrossOrchestrators('org-1', 'active');

    expect(aurora.isTenantReady).toHaveBeenCalledWith('org-1');
  });

  it('skips orchestrators whose tenant is not ready', async () => {
    const fth = fakeOrchestrator('fth', null);
    mockGetAvailableOrchestrators.mockReturnValue([fth]);

    await setTenantStatusAcrossOrchestrators('org-1', 'disabled');

    expect(fth.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('propagates errors from updateTenantStatus', async () => {
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1');
    aurora.updateTenantStatus.mockRejectedValue(new Error('Aurora API error'));
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await expect(setTenantStatusAcrossOrchestrators('org-1', 'active')).rejects.toThrow(
      'Aurora API error',
    );
  });
});

describe('resolveReadyTenants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the available orchestrators for the current stage', async () => {
    mockGetAvailableOrchestrators.mockReturnValue([]);

    await resolveReadyTenants('org-1');

    expect(mockGetAvailableOrchestrators).toHaveBeenCalledWith('test');
  });

  it('returns each orchestrator paired with its resolved tenant', async () => {
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1');
    const fth = fakeOrchestrator('fth', 'fth-t-1');
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const result = await resolveReadyTenants('org-1');

    expect(result).toEqual([
      { orchestrator: aurora, tenantId: 'aurora-t-1' },
      { orchestrator: fth, tenantId: 'fth-t-1' },
    ]);
  });

  it('omits orchestrators whose tenant is not ready', async () => {
    const aurora = fakeOrchestrator('aurora', 'aurora-t-1');
    const fth = fakeOrchestrator('fth', null);
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const result = await resolveReadyTenants('org-1');

    expect(result).toEqual([{ orchestrator: aurora, tenantId: 'aurora-t-1' }]);
  });

  it('returns an empty array when no orchestrator has a ready tenant', async () => {
    const aurora = fakeOrchestrator('aurora', null);
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const result = await resolveReadyTenants('org-1');

    expect(result).toEqual([]);
  });
});
