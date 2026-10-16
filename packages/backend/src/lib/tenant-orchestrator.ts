import type { TenantStatus } from '@filone/shared';
import type { OrgProfileItem } from './org-profile.ts';
import type { OrchestratorRequestOptions } from './service-orchestrator.ts';

/**
 * Result of a live tenant-status probe against an orchestrator's API.
 *
 * - `ok` carries the normalized {@link TenantStatus}, or `undefined` when the
 *   orchestrator reports a status value we don't model.
 * - `not_found` means the orchestrator has no such tenant (e.g. 404).
 * - `error` means the probe could not be completed (transport/server error);
 *   `cause` is the underlying error.
 */
export type TenantStatusProbe =
  | { kind: 'ok'; status: TenantStatus | undefined }
  | { kind: 'not_found' }
  | { kind: 'error'; cause: unknown };

/** Tenant provisioning and lifecycle. */
export interface TenantOrchestrator {
  /**
   * Resolves the org's tenant on this orchestrator, provisioning it if needed
   * and advancing the setup state machine on the `ORG#{orgId}/PROFILE` row.
   *
   * This call has side effects: it may issue API calls towards service orchestrators,
   * write to DDB, increment failure counters, and transition status between setup states.
   * Only call from write paths (POST/PUT/DELETE handlers, background jobs);
   * GET handlers should use `getOrgProfile` + {@link isTenantReady}.
   *
   * @param orgId - Internal org UUID from `event.requestContext.userInfo.orgId`.
   * @returns The resolved `tenantId` once the tenant is fully provisioned,
   *          or `null` if setup is still in progress or has failed.
   */
  ensureTenantReady(
    orgId: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<string | null>;

  /**
   * Side-effect-free readiness check: extracts this orchestrator's `tenantId`
   * from a pre-fetched `ORG#{orgId}/PROFILE` item (see `getOrgProfile`),
   * returning it only if the tenant is already fully set up. Pure and
   * synchronous — callers that consult several orchestrators read the row
   * once instead of once per orchestrator.
   *
   * Unlike {@link ensureTenantReady}, this never advances the setup state
   * machine, issues Portal/Backoffice API calls, or performs any I/O — safe
   * to call from GET handlers and other read paths where triggering
   * provisioning would be inappropriate.
   *
   * @param orgProfile - The PROFILE item, or `undefined` when the row is missing.
   * @returns The `tenantId` if ready, otherwise `null` (not yet provisioned,
   *          in progress, or failed).
   */
  isTenantReady(orgProfile: OrgProfileItem | undefined): string | null;

  /**
   * Sets the tenant's status on this orchestrator's API (e.g. locking or
   * unlocking writes when billing state changes). Like the other non-setup
   * methods this is stateless and takes a `tenantId` directly — it calls the
   * orchestrator API only and does not write to DDB.
   */
  updateTenantStatus(
    tenantId: string,
    status: TenantStatus,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<void>;

  /**
   * Permanently deletes the tenant and everything it owns (buckets, objects,
   * access keys). Irreversible and synchronous.
   *
   * MUST be idempotent, because the teardown re-runs it: a 404 from either the
   * disable or the delete means the tenant is gone, which is the postcondition.
   * The disable is only the delete's precondition, so its 404 must not skip the
   * delete — a partially-failed pass leaves resources still to collect.
   */
  deleteTenant(tenantId: string, requestOptions?: OrchestratorRequestOptions): Promise<void>;

  /**
   * Reads the tenant's current live status from this orchestrator's API. Like
   * the other non-setup methods it is stateless and takes a `tenantId` directly,
   * issues an orchestrator API call only, and never writes to DDB. Never throws:
   * transport/server failures are returned as `{ kind: 'error' }` so background
   * jobs can classify them (see {@link TenantStatusProbe}).
   */
  getTenantStatus(
    tenantId: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<TenantStatusProbe>;
}
