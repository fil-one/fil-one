import type {
  AccessKeyPermission,
  GranularPermission,
  RetentionDurationType,
  RetentionMode,
  S3Region,
} from '@filone/shared';

export interface PresignerContext {
  endpointUrl: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  forcePathStyle: boolean;
}

export interface BucketSummary {
  name: string;
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

export class BucketAlreadyExistsError extends Error {
  constructor(bucketName: string, options?: ErrorOptions) {
    super(`Bucket "${bucketName}" already exists`, options);
    this.name = 'BucketAlreadyExistsError';
  }
}

export class AccessKeyAlreadyExistsError extends Error {
  constructor(options?: ErrorOptions) {
    super('An access key with this name already exists', options);
    this.name = 'AccessKeyAlreadyExistsError';
  }
}

export class AccessKeyValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AccessKeyValidationError';
  }
}

export class NotImplementedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NotImplementedError';
  }
}

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
 * `ensureTenantReady` / `isTenantReady` take `orgId` because they own the
 * setup state machine (status, failure counts, transitions) which lives on
 * the org row. Every other method takes `tenantId` directly — those are
 * stateless calls, and callers are expected to have resolved org → tenant
 * via ensure/isReady first.
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
   * GET handlers should use {@link isTenantReady}.
   *
   * @param orgId - Internal org UUID from `event.requestContext.userInfo.orgId`.
   * @returns The resolved `tenantId` once the tenant is fully provisioned,
   *          or `null` if setup is still in progress or has failed.
   */
  ensureTenantReady(orgId: string): Promise<string | null>;

  /**
   * Side-effect-free readiness check. Reads the current state from DDB and
   * returns the `tenantId` only if the tenant is already fully set up.
   *
   * Unlike {@link ensureTenantReady}, this never advances the setup state
   * machine, issues Portal/Backoffice API calls, or writes to DDB — safe to
   * call from GET handlers and other read paths where triggering provisioning
   * would be inappropriate.
   *
   * @param orgId - Internal org UUID.
   * @returns The `tenantId` if ready, otherwise `null` (not yet provisioned,
   *          in progress, or failed).
   */
  isTenantReady(orgId: string): Promise<string | null>;

  createBucket(tenantId: string, args: CreateBucketArgs): Promise<void>;
  deleteBucket(tenantId: string, bucketName: string): Promise<void>;
  listBuckets(tenantId: string): Promise<BucketSummary[]>;
  getBucket(tenantId: string, bucketName: string): Promise<BucketDetails | null>;

  issueAccessKey(tenantId: string, opts: IssueAccessKeyOpts): Promise<IssuedAccessKey>;
  findAccessKeyByName(
    tenantId: string,
    keyName: string,
  ): Promise<{ id: string; accessKeyId: string; createdAt: string } | undefined>;

  getPresignerContext(tenantId: string): Promise<PresignerContext>;
}
