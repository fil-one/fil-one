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
  /** The region that will serve the bucket, which must be one the network serves. */
  region: S3Region;
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
/**
 * A bucket as callers address it. A bucket is served by exactly one region, and
 * only that region's gateway can act on it, so the region travels with the name.
 */
export interface BucketRef {
  region: S3Region;
  bucketName: string;
}

export interface BucketOrchestrator {
  createBucket(
    tenantId: string,
    args: CreateBucketArgs,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<void>;
  deleteBucket(
    tenantId: string,
    bucket: BucketRef,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<void>;
  /**
   * Every bucket the tenant holds on this network, each labelled with the
   * region serving it, or with `memberId` only the ones that member can
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
    bucket: BucketRef,
    memberId?: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<BucketDetails | null>;

  /**
   * Credentials and endpoint for the S3 gateway of `region`, which must be one
   * the network serves. The credential is the tenant's console key, the same at
   * every region; the endpoint and signing region are the region's.
   */
  getS3ClientContext(
    tenantId: string,
    region: S3Region,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<S3ClientContext>;
}
