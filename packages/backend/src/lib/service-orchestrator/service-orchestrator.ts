import type {
  AccessKeyPermission,
  GranularPermission,
  ProviderId,
  RetentionDurationType,
  RetentionMode,
  S3Region,
} from '@filone/shared';

export type TenantNotReadyReason = 'setup-incomplete';

export type EnsureTenantReadyResult =
  | { ok: true; tenantId: string }
  | { ok: false; reason: TenantNotReadyReason };

export interface PresignerContext {
  endpointUrl: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  forcePathStyle: boolean;
}

export interface BucketSummary {
  name: string;
  createdAt: string;
  versioning?: boolean;
  encrypted?: boolean;
}

export interface BucketDetails extends BucketSummary {
  objectLockEnabled?: boolean;
  defaultRetention?: RetentionMode;
  retentionDuration?: number;
  retentionDurationType?: RetentionDurationType;
}

export interface CreateBucketArgs {
  tenantId: string;
  name: string;
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
  constructor(bucketName: string) {
    super(`Bucket "${bucketName}" already exists`);
    this.name = 'BucketAlreadyExistsError';
  }
}

export class AccessKeyAlreadyExistsError extends Error {
  constructor() {
    super('An access key with this name already exists');
    this.name = 'AccessKeyAlreadyExistsError';
  }
}

export class AccessKeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessKeyValidationError';
  }
}

/**
 * orgId vs tenantId:
 * - `orgId` is our internal org identifier — a UUID generated on a
 *   user's first authenticated request and persisted in UserInfoTable.
 *   Provider-agnostic, one per org, attached to every request
 *   via `event.requestContext.userInfo.orgId`.
 * - `tenantId` is the provider-specific identifier the data-plane API
 *   accepts (e.g. `auroraTenantId`). It maps 1:1 to `(orgId, providerId)`
 *   and is stored on the `ORG#{orgId}/PROFILE` DDB row.
 *
 * `ensureTenantReady` / `isTenantReady` take `orgId` because they own the
 * setup state machine (status, failure counts, transitions) which lives on
 * the org row. Every other method takes `tenantId` directly — those are
 * stateless data-plane calls, and callers are expected to have resolved
 * org → tenant via ensure/isReady first.
 */
export interface ServiceOrchestrator {
  readonly id: ProviderId;
  readonly region: S3Region;

  ensureTenantReady(orgId: string): Promise<EnsureTenantReadyResult>;

  /**
   * Side-effect-free readiness check. Returns the tenantId if the org's tenant
   * for this provider is fully set up, otherwise null. Unlike
   * ensureTenantReady, this never advances the setup state machine — safe to
   * call from GET handlers that should not trigger Portal/Backoffice API
   * calls or DDB writes.
   */
  isTenantReady(orgId: string): Promise<{ tenantId: string } | null>;

  createBucket(args: CreateBucketArgs): Promise<void>;
  deleteBucket(tenantId: string, name: string): Promise<void>;
  listBuckets(tenantId: string): Promise<BucketSummary[]>;
  getBucket(tenantId: string, name: string): Promise<BucketDetails | null>;

  issueAccessKey(tenantId: string, opts: IssueAccessKeyOpts): Promise<IssuedAccessKey>;
  findAccessKeyByName(
    tenantId: string,
    keyName: string,
  ): Promise<{ id: string; accessKeyId: string; createdAt: string } | undefined>;

  getPresignerContext(tenantId: string): Promise<PresignerContext>;
}
