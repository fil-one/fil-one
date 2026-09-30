import type { BucketPolicy, RetentionDurationType, RetentionMode, S3Region } from '@filone/shared';
import type { S3ClientContext } from './s3-client.ts';
import type { OrchestratorRequestOptions } from './service-orchestrator.ts';

/**
 * Object-lock and retention state. Neither orchestrator's bucket *list* carries
 * it, and a per-bucket read on every row would mean an N+1 on a page every user
 * hits, so it's loaded only for a single bucket (see {@link BucketDetails}).
 */
export interface BucketProtection {
  objectLockEnabled?: boolean;
  defaultRetention?: RetentionMode;
  retentionDuration?: number;
  retentionDurationType?: RetentionDurationType;
}

/**
 * A row in the bucket list: only what each provider's native list call already
 * returns inline, so listing a tenant's buckets costs one call per orchestrator
 * regardless of bucket count. Versioning and object-lock aren't included for the
 * same reason — both cost a call per bucket on at least one orchestrator.
 */
export interface BucketSummary {
  bucketName: string;
  region: S3Region;
  createdAt: string;
  isPublic: boolean;
  encrypted: boolean;
}

/** A single-bucket read, which always loads versioning and the protection state. */
export interface BucketDetails extends BucketProtection {
  bucketName: string;
  region: S3Region;
  /**
   * Absent where existence is proved by a bucket-addressed read rather than a
   * tenant listing: S3 carries no per-bucket creation date and the Management
   * API has none either. The bucket list still carries it.
   */
  createdAt?: string;
  isPublic: boolean;
  versioning: boolean;
  encrypted: boolean;
}

export interface CreateBucketArgs {
  bucketName: string;
  versioning?: boolean;
  lock?: boolean;
  /**
   * The policy the bucket starts with, on a region serving the `iam` access
   * model. Never set on a `service-keys` region.
   */
  policy?: BucketPolicy;
  retention?: {
    enabled: boolean;
    mode: RetentionMode;
    duration: number;
    durationType: RetentionDurationType;
  };
}

/** Bucket lifecycle, and the S3 client context object requests sign with. */
export interface BucketOrchestrator {
  createBucket(
    tenantId: string,
    args: CreateBucketArgs,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<void>;
  deleteBucket(
    tenantId: string,
    bucketName: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<void>;
  /**
   * The tenant's buckets, or with `memberId` only the ones that member can
   * access. Tenant-wide callers omit it. A region serving the `iam` access
   * model honours it and every other region ignores it, so a region that
   * flips models cannot break its callers in either direction.
   */
  listBuckets(
    tenantId: string,
    memberId?: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<BucketSummary[]>;
  /**
   * One bucket, or null when the tenant has none by that name. With `memberId`
   * a region serving the `iam` access model answers null for a bucket the
   * member cannot reach; every other region ignores it.
   */
  getBucket(
    tenantId: string,
    bucketName: string,
    memberId?: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<BucketDetails | null>;

  getS3ClientContext(
    tenantId: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<S3ClientContext>;
}
