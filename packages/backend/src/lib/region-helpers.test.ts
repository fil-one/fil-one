import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetAvailableOrchestrators = vi.fn();
vi.mock('./service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: (...args: unknown[]) => mockGetAvailableOrchestrators(...args),
}));

const mockGetOrgProfile = vi.fn<(orgId: string) => Promise<OrgProfileItem | undefined>>(
  async (orgId: string) => fakeOrgProfile(orgId),
);
// Only the read is stubbed — `isOrgDeleting` stays real so the fence is
// exercised as the predicate every other `deleting` reader uses.
vi.mock('./org-profile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./org-profile.js')>()),
  getOrgProfile: (...args: unknown[]) => mockGetOrgProfile(...(args as [string])),
}));

process.env.FILONE_STAGE = 'test';

import {
  assertRegionSyncSucceeded,
  getProvisionedRegions,
  getRegionsWithTenantIds,
  getRegionsWithTenantIdsForOrg,
  syncTenantStatusInProvisionedRegions,
  WEBHOOK_STATUS_SYNC_RETRY,
  type RegionSyncOutcome,
} from './region-helpers.js';
import type { OrgProfileItem } from './org-profile.js';
import { fakeOrchestrator, fakeOrgProfile } from '../test/fake-orchestrator.js';

describe('syncTenantStatusInProvisionedRegions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks clears calls, not implementations — restore the default
    // "org is alive" profile so a fence test cannot leak into the next one.
    mockGetOrgProfile.mockImplementation(async (orgId: string) => fakeOrgProfile(orgId));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates a region whose status differs from the desired status', async () => {
    const aurora = fakeOrchestrator('aurora', { status: 'active' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'write-locked');

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith('aurora:org-1', 'write-locked');
  });

  it('skips the update when the region status already matches', async () => {
    const aurora = fakeOrchestrator('aurora', { status: 'write-locked' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'write-locked');

    expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('returns per-region outcomes distinguishing in-sync from updated regions', async () => {
    const aurora = fakeOrchestrator('aurora', { status: 'write-locked' });
    const fth = fakeOrchestrator('fth', { status: 'active' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);

    const result = await syncTenantStatusInProvisionedRegions('org-1', 'write-locked');

    expect(result.outcomes).toEqual([
      { orchestratorId: 'aurora', tenantId: 'aurora:org-1', outcome: 'in-sync' },
      { orchestratorId: 'fth', tenantId: 'fth:org-1', outcome: 'updated' },
    ]);
  });

  it('reports a not-found tenant without updating it', async () => {
    const fth = fakeOrchestrator('fth');
    fth.getTenantStatus.mockResolvedValue({ kind: 'not_found' });
    mockGetAvailableOrchestrators.mockReturnValue([fth]);

    const result = await syncTenantStatusInProvisionedRegions('org-1', 'disabled');

    expect(result.outcomes).toEqual([
      { orchestratorId: 'fth', tenantId: 'fth:org-1', outcome: 'not-found' },
    ]);
  });

  it('does not call updateTenantStatus for a not-found tenant', async () => {
    const fth = fakeOrchestrator('fth');
    fth.getTenantStatus.mockResolvedValue({ kind: 'not_found' });
    mockGetAvailableOrchestrators.mockReturnValue([fth]);

    await syncTenantStatusInProvisionedRegions('org-1', 'disabled');

    expect(fth.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('never downgrades a disabled tenant to write-locked', async () => {
    const aurora = fakeOrchestrator('aurora', { status: 'disabled' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'write-locked');

    expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
  });

  it('reports a skipped outcome for a disabled tenant left untouched', async () => {
    const aurora = fakeOrchestrator('aurora', { status: 'disabled' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const result = await syncTenantStatusInProvisionedRegions('org-1', 'write-locked');

    expect(result.outcomes).toEqual([
      { orchestratorId: 'aurora', tenantId: 'aurora:org-1', outcome: 'skipped' },
    ]);
  });

  it('re-activates a disabled tenant when the desired status is active', async () => {
    const aurora = fakeOrchestrator('aurora', { status: 'disabled' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'active');

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith('aurora:org-1', 'active');
  });

  describe('FIL-112 org-profile `deleting` guard — re-activation only', () => {
    /** Make the profile read report an org whose teardown has started. */
    function orgIsDeleting(orgId = 'org-1') {
      mockGetOrgProfile.mockResolvedValue({ ...fakeOrgProfile(orgId), deleting: { BOOL: true } });
    }

    it('refuses to re-activate a deleting org and reports `refused` per region', async () => {
      // Aurora's teardown fails fatally when it cannot confirm DISABLED, so a
      // re-activation here can wedge the whole deletion permanently.
      const aurora = fakeOrchestrator('aurora', { status: 'disabled' });
      mockGetAvailableOrchestrators.mockReturnValue([aurora]);
      orgIsDeleting();

      const result = await syncTenantStatusInProvisionedRegions('org-1', 'active');

      expect(aurora.updateTenantStatus).not.toHaveBeenCalled();
      expect(aurora.getTenantStatus).not.toHaveBeenCalled();
      expect(result.outcomes).toEqual([
        { orchestratorId: 'aurora', tenantId: 'aurora:org-1', outcome: 'refused' },
      ]);
      expect(result.refusedForDeletion).toBe(true);
    });

    it('reports the refusal for a deleting org with NO provisioned region', async () => {
      // The refusal must be an org-level fact, not a property of the per-region
      // outcomes: an org that never provisioned a tenant produces none, so any
      // `outcomes.some(o => o.outcome === 'refused')` test answers "not refused"
      // and the caller goes on to log "Tenant unlocked" for a deleting org.
      mockGetAvailableOrchestrators.mockReturnValue([fakeOrchestrator('aurora', { ready: false })]);
      orgIsDeleting();

      const result = await syncTenantStatusInProvisionedRegions('org-1', 'active');

      expect(result.outcomes).toEqual([]);
      expect(result.refusedForDeletion).toBe(true);
    });

    it('reads the profile strongly-consistently when re-activating (the flag fails open)', async () => {
      mockGetAvailableOrchestrators.mockReturnValue([fakeOrchestrator('aurora')]);

      await syncTenantStatusInProvisionedRegions('org-1', 'active');

      expect(mockGetOrgProfile).toHaveBeenCalledWith('org-1', { consistent: true });
    });

    it('still DISABLES a deleting org — teardown depends on it', async () => {
      const aurora = fakeOrchestrator('aurora', { status: 'active' });
      mockGetAvailableOrchestrators.mockReturnValue([aurora]);
      orgIsDeleting();

      const result = await syncTenantStatusInProvisionedRegions('org-1', 'disabled');

      expect(aurora.updateTenantStatus).toHaveBeenCalledWith('aurora:org-1', 'disabled');
      expect(result.refusedForDeletion).toBe(false);
    });

    it('still WRITE-LOCKS a deleting org (the grace-period enforcer path)', async () => {
      const aurora = fakeOrchestrator('aurora', { status: 'active' });
      mockGetAvailableOrchestrators.mockReturnValue([aurora]);
      orgIsDeleting();

      await syncTenantStatusInProvisionedRegions('org-1', 'write-locked');

      expect(aurora.updateTenantStatus).toHaveBeenCalledWith('aurora:org-1', 'write-locked');
    });

    it('re-activates normally when the org is not deleting', async () => {
      const aurora = fakeOrchestrator('aurora', { status: 'disabled' });
      mockGetAvailableOrchestrators.mockReturnValue([aurora]);

      const result = await syncTenantStatusInProvisionedRegions('org-1', 'active');

      expect(aurora.updateTenantStatus).toHaveBeenCalledWith('aurora:org-1', 'active');
      expect(result.refusedForDeletion).toBe(false);
    });

    it('a refused sync is not an error — assertRegionSyncSucceeded lets it through', async () => {
      mockGetAvailableOrchestrators.mockReturnValue([fakeOrchestrator('aurora')]);
      orgIsDeleting();

      const result = await syncTenantStatusInProvisionedRegions('org-1', 'active');

      // Nothing failed and re-driving would not help, so callers must branch on
      // `refusedForDeletion` rather than on a thrown error.
      expect(() => assertRegionSyncSucceeded(result.outcomes)).not.toThrow();
    });
  });

  it('escalates a write-locked tenant to disabled', async () => {
    const aurora = fakeOrchestrator('aurora', { status: 'write-locked' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    await syncTenantStatusInProvisionedRegions('org-1', 'disabled');

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith('aurora:org-1', 'disabled');
  });

  it('retries a transient probe error and syncs the region', async () => {
    vi.useFakeTimers();
    const aurora = fakeOrchestrator('aurora');
    aurora.getTenantStatus
      .mockResolvedValueOnce({ kind: 'error', cause: new Error('transient outage') })
      .mockResolvedValue({ kind: 'ok', status: 'active' });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const promise = syncTenantStatusInProvisionedRegions('org-1', 'write-locked');
    await vi.runAllTimersAsync();
    await promise;

    expect(aurora.updateTenantStatus).toHaveBeenCalledWith('aurora:org-1', 'write-locked');
  });

  it('returns an error outcome when the probe keeps failing past all retries (1 initial + 3 retries)', async () => {
    vi.useFakeTimers();
    const aurora = fakeOrchestrator('aurora');
    aurora.getTenantStatus.mockResolvedValue({ kind: 'error', cause: new Error('outage') });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const promise = syncTenantStatusInProvisionedRegions('org-1', 'write-locked');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.outcomes).toMatchObject([
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

    const promise = syncTenantStatusInProvisionedRegions('org-1', 'write-locked');
    await vi.runAllTimersAsync();
    await promise;

    expect(fth.updateTenantStatus).toHaveBeenCalledWith('fth:org-1', 'write-locked');
  });

  it('returns an error outcome with the cause when updateTenantStatus keeps failing past all retries (1 initial + 3 retries)', async () => {
    vi.useFakeTimers();
    const updateError = new Error('FTH API error');
    const fth = fakeOrchestrator('fth', { status: 'active' });
    fth.updateTenantStatus.mockRejectedValue(updateError);
    mockGetAvailableOrchestrators.mockReturnValue([fth]);

    const promise = syncTenantStatusInProvisionedRegions('org-1', 'write-locked');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.outcomes).toEqual([
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

    const promise = syncTenantStatusInProvisionedRegions('org-1', 'write-locked');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.outcomes).toEqual([
      { orchestratorId: 'fth', tenantId: 'fth:org-1', outcome: 'updated' },
    ]);
  });

  it('honors a tighter retry override (1 initial + 1 retry)', async () => {
    vi.useFakeTimers();
    const aurora = fakeOrchestrator('aurora');
    aurora.getTenantStatus.mockResolvedValue({ kind: 'error', cause: new Error('outage') });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);

    const promise = syncTenantStatusInProvisionedRegions(
      'org-1',
      'write-locked',
      WEBHOOK_STATUS_SYNC_RETRY,
    );
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

    expect(mockGetOrgProfile.mock.calls).toEqual([['org-1']]);
  });

  it('does not fetch the PROFILE row when no orchestrator is available', async () => {
    mockGetAvailableOrchestrators.mockReturnValue([]);

    await getProvisionedRegions('org-1');

    expect(mockGetOrgProfile).not.toHaveBeenCalled();
  });
});

describe('getRegionsWithTenantIds (raw teardown-target resolution)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a region whose tenant-id attribute exists even when isTenantReady says not ready', () => {
    // Half-provisioned tenant: the id was persisted mid-setup, readiness never
    // reached. isTenantReady hides it; the raw variant must not.
    const aurora = fakeOrchestrator('aurora', { ready: false });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);
    const profile = {
      pk: { S: 'ORG#org-1' },
      auroraTenantId: { S: 'aurora-mid-setup' },
      auroraSetupStatus: { S: 'AURORA_TENANT_CREATED' },
    };

    expect(getRegionsWithTenantIds(profile)).toEqual([
      { orchestrator: aurora, tenantId: 'aurora-mid-setup' },
    ]);
    // Raw resolution never consults readiness.
    expect(aurora.isTenantReady).not.toHaveBeenCalled();
  });

  it('omits regions with no tenant-id attribute on the profile', () => {
    const aurora = fakeOrchestrator('aurora');
    const fth = fakeOrchestrator('fth');
    mockGetAvailableOrchestrators.mockReturnValue([aurora, fth]);
    const profile = { pk: { S: 'ORG#org-1' }, fthTenantId: { S: 'fth-t-1' } };

    expect(getRegionsWithTenantIds(profile)).toEqual([{ orchestrator: fth, tenantId: 'fth-t-1' }]);
  });

  it('returns an empty array for a missing profile', () => {
    mockGetAvailableOrchestrators.mockReturnValue([fakeOrchestrator('aurora')]);

    expect(getRegionsWithTenantIds(undefined)).toEqual([]);
  });
});

describe('getRegionsWithTenantIdsForOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the profile once, STRONGLY CONSISTENTLY, and resolves raw tenant ids from it', async () => {
    const aurora = fakeOrchestrator('aurora', { ready: false });
    mockGetAvailableOrchestrators.mockReturnValue([aurora]);
    const midSetupProfile = {
      pk: { S: 'ORG#org-1' },
      auroraTenantId: { S: 'aurora-mid-setup' },
    };
    mockGetOrgProfile.mockResolvedValue(midSetupProfile);

    const result = await getRegionsWithTenantIdsForOrg('org-1');

    expect(result).toEqual([{ orchestrator: aurora, tenantId: 'aurora-mid-setup' }]);
    // Both callers are teardown paths: a stale read skips the region, and the
    // profile — the only pointer to the tenant id — is purged right after.
    expect(mockGetOrgProfile.mock.calls).toEqual([['org-1', { consistent: true }]]);
  });

  it('does not fetch the PROFILE row when no orchestrator is available', async () => {
    mockGetAvailableOrchestrators.mockReturnValue([]);

    await expect(getRegionsWithTenantIdsForOrg('org-1')).resolves.toEqual([]);

    expect(mockGetOrgProfile).not.toHaveBeenCalled();
  });
});
