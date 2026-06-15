import type {
  AccessKeyPermission,
  GranularPermission,
  RetentionDurationType,
  RetentionMode,
  S3Region,
} from '@filone/shared';
import type { S3ClientContext } from './s3-client.js';
import type { OrgProfileItem } from './org-profile.js';

export interface BucketSummary {
  bucketName: string;
  region: S3Region;
  createdAt: string;
  isPublic: boolean;
  versioning: boolean;
  encrypted: boolean;
}

export interface BucketDetails extends BucketSummary {
  objectLockEnabled?: boolean;
  defaultRetention?: RetentionMode;
  retentionDuration?: number;
  retentionDurationType?: RetentionDurationType;
}

export interface CreateBucketArgs {
  bucketName: string;
  versioning?: boolean;
  lock?: boolean;
  retention?: {
    enabled: boolean;
    mode: RetentionMode;
    duration: number;
    durationType: RetentionDurationType;
  };
}

export interface IssueAccessKeyOpts {
  keyName: string;
  permissions: AccessKeyPermission[];
  granularPermissions?: GranularPermission[];
  buckets?: string[];
  expiresAt?: string | null;
}

export interface IssuedAccessKey {
  id: string;
  accessKeyId: string;
  accessKeySecret: string;
  createdAt: string;
}

/**
 * A single point in a tenant's storage-usage time series.
 */
export interface StorageUsageSample {
  /** Canonical ISO-8601 UTC timestamp (e.g. `2026-01-01T10:00:00.000Z`). */
  timestamp: string;
  bytesUsed: number;
  /** 0 when the orchestrator's source has no object-count series. */
  objectCount: number;
}

/** A single point in a tenant's egress time series. `timestamp` is canonical ISO-8601 UTC (see {@link StorageUsageSample}). */
export interface EgressUsageSample {
  /** Canonical ISO-8601 UTC timestamp (e.g. `2026-01-01T10:00:00.000Z`). */
  timestamp: string;
  bytesUsed: number;
}

/** Normalized, orchestrator-agnostic usage/egress time series for a tenant. */
export interface TenantUsageMetrics {
  storage: StorageUsageSample[];
  egress: EgressUsageSample[];
}

export interface GetTenantUsageMetricsOptions {
  /** Inclusive start timestamp, RFC3339 UTC. */
  from: string;
  /** Exclusive end timestamp, RFC3339 UTC. */
  to: string;
  /** Sampling window applied to BOTH series. Defaults to '1d'. */
  interval?: string;
}

/**
 * Orchestrator-agnostic tenant status. These are the three lowercase-dashed
 * values shared by every orchestrator. Aurora's generated `ModelsTenantStatus`
 * additionally has a never-used `LOCKED` value we intentionally don't model.
 */
export type TenantStatus = 'active' | 'write-locked' | 'disabled';

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

/**
 * Abstraction over a service orchestrator (e.g. Aurora, FTH, etc.).
 * Each implementation handles tenant provisioning, bucket lifecycle,
 * access-key issuance, and presigning for a service orchestrator in a single region.
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
export interface ServiceOrchestrator {
  readonly id: string;
  readonly region: S3Region;

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
  ensureTenantReady(orgId: string): Promise<string | null>;

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

  createBucket(tenantId: string, args: CreateBucketArgs): Promise<void>;
  deleteBucket(tenantId: string, bucketName: string): Promise<void>;
  listBuckets(tenantId: string): Promise<BucketSummary[]>;
  getBucket(tenantId: string, bucketName: string): Promise<BucketDetails | null>;

  /**
   * Sets the tenant's status on this orchestrator's API (e.g. locking or
   * unlocking writes when billing state changes). Like the other non-setup
   * methods this is stateless and takes a `tenantId` directly — it calls the
   * orchestrator API only and does not write to DDB.
   */
  updateTenantStatus(tenantId: string, status: TenantStatus): Promise<void>;

  /**
   * Reads the tenant's current live status from this orchestrator's API. Like
   * the other non-setup methods it is stateless and takes a `tenantId` directly,
   * issues an orchestrator API call only, and never writes to DDB. Never throws:
   * transport/server failures are returned as `{ kind: 'error' }` so background
   * jobs can classify them (see {@link TenantStatusProbe}).
   */
  getTenantStatus(tenantId: string): Promise<TenantStatusProbe>;

  issueAccessKey(tenantId: string, opts: IssueAccessKeyOpts): Promise<IssuedAccessKey>;
  findAccessKeyByName(
    tenantId: string,
    keyName: string,
  ): Promise<{ id: string; accessKeyId: string; createdAt: string } | undefined>;

  /**
   * Revokes an access key. Implementations MUST be idempotent: a missing key
   * (already deleted upstream) is treated as success, not an error. Any other
   * failure should propagate so the caller can leave the DDB row intact.
   */
  deleteAccessKey(tenantId: string, keyId: string): Promise<void>;

  getS3ClientContext(tenantId: string): Promise<S3ClientContext>;

  /**
   * Returns the tenant's storage and egress usage as normalized time series
   * over `[from, to)`. Read-only — does not mutate tenant state. Backs both the
   * usage-reporting worker and read-path handlers (e.g. get-activity).
   */
  getTenantUsageMetrics(
    tenantId: string,
    opts: GetTenantUsageMetricsOptions,
  ): Promise<TenantUsageMetrics>;
}
