import { vi } from 'vitest';

export interface FakeOrchestrator {
  id: string;
  isTenantReady: ReturnType<typeof vi.fn>;
  getTenantStatus: ReturnType<typeof vi.fn>;
  updateTenantStatus: ReturnType<typeof vi.fn>;
}

/**
 * Builds a fake ServiceOrchestrator covering the methods exercised by the
 * tenant status-sync code paths. The tenant id is derived from the orgId
 * (see {@link tenantFor}) so per-org assertions stay unambiguous; pass
 * `ready: false` to simulate a region where the tenant is not provisioned.
 */
export function fakeOrchestrator(
  id: string,
  opts: { ready?: boolean; status?: string } = {},
): FakeOrchestrator {
  const { ready = true, status = 'active' } = opts;
  return {
    id,
    isTenantReady: vi.fn(async (orgId: string) => (ready ? tenantFor(id, orgId) : null)),
    getTenantStatus: vi.fn(async () => ({ kind: 'ok', status })),
    updateTenantStatus: vi.fn().mockResolvedValue(undefined),
  };
}

/** The tenant id a {@link fakeOrchestrator} resolves for the given org. */
export function tenantFor(orchestratorId: string, orgId: string): string {
  return `${orchestratorId}:${orgId}`;
}
