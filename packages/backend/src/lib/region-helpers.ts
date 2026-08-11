import pRetry, { type Options as RetryOptions } from 'p-retry';
import { getAvailableOrchestrators } from './service-orchestrator-registry.js';
import { getOrgProfile, isOrgDeleting, type OrgProfileItem } from './org-profile.js';
import type { ServiceOrchestrator } from './service-orchestrator.js';
import type { TenantStatus } from '@filone/shared/src/api/tenants.js';

export interface ProvisionedRegion {
  orchestrator: ServiceOrchestrator;
  tenantId: string;
}

/**
 * Synchronous variant of {@link getProvisionedRegions} for callers that have
 * already fetched the `ORG#{orgId}/PROFILE` item: resolves each available
 * orchestrator's tenant from the given profile without re-reading it.
 */
export function getProvisionedRegionsFromProfile(
  orgProfile: OrgProfileItem | undefined,
): ProvisionedRegion[] {
  return getAvailableOrchestrators()
    .map((orchestrator) => {
      const tenantId = orchestrator.isTenantReady(orgProfile);
      return tenantId ? { orchestrator, tenantId } : null;
    })
    .filter((t): t is ProvisionedRegion => t !== null);
}

export async function getProvisionedRegions(orgId: string): Promise<ProvisionedRegion[]> {
  const orchestrators = getAvailableOrchestrators();
  if (orchestrators.length === 0) return [];
  return getProvisionedRegionsFromProfile(await getOrgProfile(orgId));
}

/**
 * Raw teardown-scoped variant of {@link getProvisionedRegionsFromProfile}:
 * returns every region whose `${id}TenantId` attribute EXISTS on the profile,
 * regardless of setup readiness. `isTenantReady` deliberately hides tenants
 * whose setup is still mid-flight, but account deletion must see them too — a
 * half-provisioned tenant already exists upstream (and may hold SSM secrets),
 * and purging the profile row (the only pointer to it) would leak it forever.
 * Every orchestrator persists its tenant id under the `${id}TenantId` PROFILE
 * attribute (see FilOneOrchestratorConfig.id), which this reads directly.
 *
 * Only teardown target resolution may use this; every serving path must keep
 * going through the readiness-gated variants above.
 */
export function getRegionsWithTenantIds(
  orgProfile: OrgProfileItem | undefined,
): ProvisionedRegion[] {
  return getAvailableOrchestrators()
    .map((orchestrator) => {
      const tenantId = orgProfile?.[`${orchestrator.id}TenantId`]?.S;
      return tenantId ? { orchestrator, tenantId } : null;
    })
    .filter((t): t is ProvisionedRegion => t !== null);
}

/**
 * Async wrapper of {@link getRegionsWithTenantIds} that reads the profile
 * itself, STRONGLY CONSISTENTLY. Every caller is a teardown path — the
 * deletion-start tenant-id snapshot (reached from the user's confirm AND from
 * the Stripe `customer.deleted` webhook) and the purge's late-region re-check —
 * and a stale read does not fail safe there: it reports "no tenant in this region",
 * the region is skipped, and the profile (the only pointer to the tenant id) is
 * then purged and the deletion marked DONE, leaking a live upstream tenant. The
 * eventual consistency that is correct for setup flows inverts here; see the
 * read-semantics note in org-profile.ts.
 */
export async function getRegionsWithTenantIdsForOrg(orgId: string): Promise<ProvisionedRegion[]> {
  if (getAvailableOrchestrators().length === 0) return [];
  return getRegionsWithTenantIds(await getOrgProfile(orgId, { consistent: true }));
}

export interface RegionSyncOutcome {
  orchestratorId: string;
  tenantId: string;
  /** `refused` = the org-profile `deleting` guard blocked a re-activation; see {@link RegionSyncResult}. */
  outcome: 'updated' | 'in-sync' | 'skipped' | 'not-found' | 'error' | 'refused';
  cause?: unknown;
}

export interface RegionSyncResult {
  /** One entry per provisioned region. Empty when the org has no tenants yet. */
  outcomes: RegionSyncOutcome[];
  /**
   * The org-profile `deleting` guard (FIL-112) refused a re-activation because the org is being deleted.
   * Callers that log success after {@link assertRegionSyncSucceeded} must
   * consult this — `refused` is deliberately not an `error` (nothing failed,
   * and re-driving would not help), so the assert lets it through.
   *
   * It is an ORG-level flag rather than a predicate over `outcomes` on purpose:
   * an org being deleted may have no provisioned regions at all, and any
   * `outcomes.some(...)` test then answers "not refused" for the very org the
   * fence just refused — which is how a deleting org came to be logged as
   * "Tenant unlocked".
   */
  refusedForDeletion: boolean;
}

// Re-raises per-region sync failures as a single error. Callers that need a
// failed sync to abort the surrounding operation (so it is retried as a whole)
// pass the outcomes of syncTenantStatusInProvisionedRegions through this.
export function assertRegionSyncSucceeded(outcomes: RegionSyncOutcome[]): void {
  const failed = outcomes.filter((o) => o.outcome === 'error');
  if (failed.length > 0) {
    throw new Error(
      `tenant status sync failed for: ${failed.map((o) => o.orchestratorId).join(', ')}`,
      { cause: failed[0].cause },
    );
  }
}

// Default for background callers — the grace-period enforcer and usage-reporting
// worker crons (60s timeouts, re-run on schedule) and the activate-subscription
// API. They have generous time budgets, so they ride out transient outages with
// several retries (p-retry's default 1s/2s/4s backoff).
const STATUS_SYNC_RETRY: RetryOptions = { retries: 3 };

// Override for the Stripe webhook, which awaits this sync synchronously and
// should return 2xx quickly (Stripe's ~2s window). syncRegionTenantStatus probes
// then updates each region (two sequential pRetry calls); with ~200-300ms
// round-trips the worst case (probe succeeds on its retry, then update exhausts
// its retry) is ≈ 2 × (2×300ms + 200ms) ≈ 1.6s — comfortably under ~2s. A
// momentary blip is ridden out; a persistent failure leaves the region out of
// sync until a later billing event re-runs this probe-first sync or the
// grace-period-enforcer cron re-attempts the lock. (The subscription-drift-checker
// only observes drift via telemetry; it does not reconcile.)
export const WEBHOOK_STATUS_SYNC_RETRY: RetryOptions = { retries: 1, minTimeout: 200 };

// Reconciles every provisioned region with the desired tenant status. Each
// region's live status is its own source of truth: probe first, update only
// when it differs. A region that fails to update still differs on the next
// run, so partial failures self-heal. Never throws — per-region failures are
// reported as `error` outcomes so callers can record them.
//
// FIL-112: `desired === 'active'` is fenced on the org's `deleting` flag, and
// only that direction — `disabled`/`write-locked` are what teardown wants and
// must keep working (the deleted-customer close-out and the grace-period
// enforcer both drive them). Three callers can otherwise re-activate a tenant
// the teardown just disabled: the usage worker's `enforceTenantLocks` for an
// under-limit org, `invoice.payment_succeeded` in the Stripe webhook, and
// `unlockAllProvisionedRegions` on activation. That is not merely untidy:
// Aurora's teardown fails fatally when it cannot confirm the tenant is
// DISABLED, so a re-activation can wedge the deletion permanently — which
// means indefinitely retaining a deleted user's data.
//
// The fence read is strongly consistent (`deleting` is absent until teardown
// starts, so a stale read fails open) and costs no extra request: it replaces
// the profile read `getProvisionedRegions` was already doing. This is the READ
// side of the org-profile `deleting` guard, so — unlike the write-side `orgNotDeletingCheck`, which
// requires the row — it is meaningful only while the PROFILE row exists: once
// the purge deletes it this reads nothing. That is harmless here, because the
// same read then resolves no provisioned region, so there is no tenant left to
// re-activate.
export async function syncTenantStatusInProvisionedRegions(
  orgId: string,
  desired: TenantStatus,
  retry: RetryOptions = STATUS_SYNC_RETRY,
): Promise<RegionSyncResult> {
  if (getAvailableOrchestrators().length === 0) {
    return { outcomes: [], refusedForDeletion: false };
  }

  const reactivating = desired === 'active';
  const orgProfile = await getOrgProfile(orgId, reactivating ? { consistent: true } : {});
  const ready = getProvisionedRegionsFromProfile(orgProfile);

  if (reactivating && isOrgDeleting(orgProfile)) {
    console.warn('[region-helpers] Refusing tenant re-activation: org deletion in progress', {
      orgId,
      regions: ready.map(({ orchestrator }) => orchestrator.id),
    });
    // The flag, not the outcomes, is the refusal signal: `ready` is empty for an
    // org that never provisioned a tenant, and that org is still refused.
    return {
      outcomes: ready.map(({ orchestrator, tenantId }) => ({
        orchestratorId: orchestrator.id,
        tenantId,
        outcome: 'refused' as const,
      })),
      refusedForDeletion: true,
    };
  }

  return {
    outcomes: await Promise.all(
      ready.map(({ orchestrator, tenantId }) =>
        syncRegionTenantStatus({ orgId, orchestrator, tenantId, desired, retry }),
      ),
    ),
    refusedForDeletion: false,
  };
}

async function syncRegionTenantStatus({
  orgId,
  orchestrator,
  tenantId,
  desired,
  retry,
}: {
  orgId: string;
  orchestrator: ServiceOrchestrator;
  tenantId: string;
  desired: TenantStatus;
  retry: RetryOptions;
}): Promise<RegionSyncOutcome> {
  const base = { orchestratorId: orchestrator.id, tenantId };
  try {
    // getTenantStatus never throws; surface `error` probes as exceptions so
    // pRetry can ride out transient orchestrator outages.
    const probe = await pRetry(async () => {
      const result = await orchestrator.getTenantStatus(tenantId);
      if (result.kind === 'error') {
        throw new Error(`${orchestrator.id} status probe failed for tenant ${tenantId}`, {
          cause: result.cause,
        });
      }
      return result;
    }, retry);

    if (probe.kind === 'not_found') {
      console.warn('[region-helpers] tenant not found, skipping status sync', {
        orgId,
        orchestrator: orchestrator.id,
        tenantId,
      });
      return { ...base, outcome: 'not-found' };
    }

    if (probe.status === desired) {
      return { ...base, outcome: 'in-sync' };
    }

    // Never downgrade a disabled tenant to write-locked. `disabled` is the
    // stronger lock; it must only be lifted by an explicit re-activation
    // (desired = 'active').
    if (probe.status === 'disabled' && desired === 'write-locked') {
      return { ...base, outcome: 'skipped' };
    }

    // A status update sets an absolute value (idempotent), so transient
    // failures are safe to retry here rather than inside each orchestrator.
    // Retrying at this level keeps the whole status-sync retry budget
    // (probe + update) in one place.
    await pRetry(() => orchestrator.updateTenantStatus(tenantId, desired), retry);
    return { ...base, outcome: 'updated' };
  } catch (cause) {
    console.error('[region-helpers] tenant status sync failed', {
      orgId,
      orchestrator: orchestrator.id,
      tenantId,
      desired,
      cause,
    });
    return { ...base, outcome: 'error', cause };
  }
}
