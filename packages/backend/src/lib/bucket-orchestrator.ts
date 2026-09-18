import type { BucketPolicy, RetentionDurationType, RetentionMode, S3Region } from '@filone/shared';
import type { S3ClientContext } from './s3-client.ts';
import type { OrchestratorRequestOptions, S3ActorOptions } from './service-orchestrator.ts';

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
  createdAt: string;
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
  listBuckets(tenantId: string, requestOptions?: S3ActorOptions): Promise<BucketSummary[]>;
  getBucket(
    tenantId: string,
    bucketName: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<BucketDetails | null>;

  getS3ClientContext(
    tenantId: string,
    requestOptions?: OrchestratorRequestOptions,
  ): Promise<S3ClientContext>;
}
