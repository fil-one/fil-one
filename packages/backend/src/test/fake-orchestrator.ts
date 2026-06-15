import { vi } from 'vitest';
import type { TenantStatus } from '../lib/service-orchestrator.js';

export interface FakeOrchestrator {
  id: string;
  isTenantReady: ReturnType<typeof vi.fn>;
  getTenantStatus: ReturnType<typeof vi.fn>;
  updateTenantStatus: ReturnType<typeof vi.fn>;
}

/**
 * Builds a fake ServiceOrchestrator covering the methods exercised by the
 * tenant status-sync code paths. The tenant id is derived from the orgId
 * carried in the {@link fakeOrgProfile} item (see {@link tenantFor}) so
 * per-org assertions stay unambiguous; pass `ready: false` to simulate a
 * region where the tenant is not provisioned.
 */
export function fakeOrchestrator(
  id: string,
  opts: { ready?: boolean; status?: TenantStatus } = {},
): FakeOrchestrator {
  const { ready = true, status = 'active' } = opts;
  return {
    id,
    isTenantReady: vi.fn((orgProfile?: { pk?: { S?: string } }) => {
      const orgId = orgProfile?.pk?.S?.replace('ORG#', '');
      return ready && orgId ? tenantFor(id, orgId) : null;
    }),
    getTenantStatus: vi.fn(async () => ({ kind: 'ok', status })),
    updateTenantStatus: vi.fn().mockResolvedValue(undefined),
  };
}

/** The PROFILE item a mocked `getOrgProfile` should resolve for the given org. */
export function fakeOrgProfile(orgId: string) {
  return { pk: { S: `ORG#${orgId}` } };
}

/** The tenant id a {@link fakeOrchestrator} resolves for the given org. */
export function tenantFor(orchestratorId: string, orgId: string): string {
  return `${orchestratorId}:${orgId}`;
}
