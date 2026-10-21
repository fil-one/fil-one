import type { S3Region } from '@filone/shared';
import type { AccessKeyOrchestrator } from './access-key-orchestrator.ts';
import type { BucketOrchestrator } from './bucket-orchestrator.ts';
import type { BucketPolicyOrchestrator } from './bucket-policy-orchestrator.ts';
import type { MemberOrchestrator } from './member-orchestrator.ts';
import type { TenantOrchestrator } from './tenant-orchestrator.ts';
import type { UsageOrchestrator } from './usage-orchestrator.ts';

export type {
  AccessKeyOrchestrator,
  IssueAccessKeyOpts,
  IssuePrincipalKeyOpts,
  IssueServiceKeyOpts,
  IssuedAccessKey,
  IssuedPrincipalKey,
  IssuedServiceKey,
} from './access-key-orchestrator.ts';
export type {
  BucketDetails,
  BucketOrchestrator,
  BucketProtection,
  BucketSummary,
  CreateBucketArgs,
} from './bucket-orchestrator.ts';
export type {
  BucketPolicyOrchestrator,
  IfMatchPrecondition,
  PolicyPrecondition,
  StoredBucketPolicy,
} from './bucket-policy-orchestrator.ts';
export type { MemberBucketPolicy, MemberOrchestrator } from './member-orchestrator.ts';
export type { TenantOrchestrator, TenantStatusProbe } from './tenant-orchestrator.ts';
export type {
  EgressUsageSample,
  GetTenantUsageMetricsOptions,
  StorageUsageSample,
  TenantInfo,
  TenantUsageMetrics,
  UsageOrchestrator,
} from './usage-orchestrator.ts';

// Retry budget for {@link TenantOrchestrator.deleteTenant}. A DELETE 409s
// unless the tenant is already `disabled`; both calls are synchronous, so a 409
// means a competing writer re-activated it in between. Each attempt re-disables,
// and the budget outlasts that writer. A 404 is not retried — see deleteTenant.
export const TENANT_DELETE_RETRY = { retries: 3 } as const;

export interface OrchestratorRequestOptions {
  /** Lets the caller abort every upstream request (HTTP or S3) the operation makes. */
  signal?: AbortSignal;
}

/** Which orchestrator this is, and the region it serves. */
export interface OrchestratorCore {
  /**
   * The orchestrator's unique identifier (e.g. `aurora`, `fth`, etc.). It
   * should have the format `^[a-z][a-zA-Z0-9_]*$`.
   */
  readonly id: string;
  readonly region: S3Region;
}

/**
 * The features every orchestrator serves: tenants, buckets, access keys and
 * usage. Aurora and FTH implement only this. Delete it once every deployment
 * implements {@link ServiceOrchestrator}.
 */
export interface LegacyServiceOrchestrator
  extends
    OrchestratorCore,
    TenantOrchestrator,
    BucketOrchestrator,
    AccessKeyOrchestrator,
    UsageOrchestrator {}

/**
 * Abstraction over a service orchestrator (e.g. Aurora, FTH, etc.) in a single
 * region, composed of one interface per feature. Members are principals,
 * buckets carry policies, and a key bound to a principal is authorized from
 * those policies on every request.
 *
 * ## orgId vs tenantId
 *
 * - `orgId` is our internal org identifier — a UUID generated on a user's
 *   first authenticated request and persisted in `UserInfoTable`.
 *   Orchestrator-agnostic, one per org, attached to every request via
 *   `event.requestContext.userInfo.orgId`.
 * - `tenantId` is the orchestrator-specific identifier (e.g. `auroraTenantId`).
 *   It maps 1:1 to `(orgId, orchestratorId)` and is stored on the
 *   `ORG#{orgId}/PROFILE` DDB row.
 *
 * `ensureTenantReady` takes `orgId` because it owns the setup state machine
 * (status, failure counts, transitions) which lives on the org row.
 * `isTenantReady` takes the pre-fetched `ORG#{orgId}/PROFILE` item (see
 * `getOrgProfile`) so callers consulting several orchestrators read the row
 * once. Every other method takes `tenantId` directly — those are stateless
 * calls, and callers are expected to have resolved org → tenant via
 * ensure/isReady first.
 */
export interface ServiceOrchestrator
  extends
    OrchestratorCore,
    TenantOrchestrator,
    BucketOrchestrator,
    AccessKeyOrchestrator,
    UsageOrchestrator,
    BucketPolicyOrchestrator,
    MemberOrchestrator {}

/**
 * Any region's orchestrator. `supportsIamMethods(orchestrator.region)` says which
 * of the two it is: the region table decides, and the registry builds the
 * orchestrator to match.
 */
export type RegionOrchestrator = LegacyServiceOrchestrator | ServiceOrchestrator;
