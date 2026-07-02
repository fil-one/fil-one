import { S3Region } from '@filone/shared';
import type { SubscriptionStatus } from '@filone/shared';

/** UserInfoTable — pk: ORG#{orgId}, sk: ACCESSKEY#{id} */
export interface AccessKeyRecord {
  pk: string;
  sk: string;
  keyName: string;
  accessKeyId: string;
  createdAt: string;
  status: string;
}

/** BillingTable — pk: CUSTOMER#{userId}, sk: SUBSCRIPTION */
export interface SubscriptionRecord {
  pk: string;
  sk: string;
  stripeCustomerId?: string;
  subscriptionStatus?: SubscriptionStatus;
  subscriptionId?: string;
  trialEndsAt?: string;
  gracePeriodEndsAt?: string;
  currentPeriodEnd?: string;
  canceledAt?: string;
  lastPaymentFailedAt?: string;
  paymentMethodId?: string;
  paymentMethodLast4?: string;
  paymentMethodBrand?: string;
  paymentMethodExpMonth?: number;
  paymentMethodExpYear?: number;
  updatedAt?: string;
}

/** Operational state of a bucket's RAG index. */
export type BucketRAGStatus = 'active' | 'disabled' | 'paused';

/**
 * Per-account RAG configuration: whether RAG is enabled and which model to use.
 *
 * UserInfoTable — pk: ORG#{orgId}, sk: RAGCONFIG
 */
export interface RAGConfigRecord {
  pk: string;
  sk: string;
  enabled: boolean;
  /** e.g. 'bedrock-titan'; left open for future model choices. */
  modelChoice?: string;
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

/**
 * Per-bucket RAG enablement, settings, and sync telemetry. Co-located with this
 * bucket's manifests: same `RagIndexerTable` partition, distinguished by sk.
 *
 * RagIndexerTable — pk: BUCKET#{orgId}#{region}#{bucketName}, sk: RAG
 */
export interface BucketRAGEnablementRecord {
  pk: string;
  sk: string;
  /**
   * Owning org. Denormalized onto the enablement row so the indexer
   * orchestrator can group RAG-enabled buckets by org during its table scan
   * without a second lookup (see rag-indexer-orchestrator).
   */
  orgId: string;
  status: BucketRAGStatus;
  filesIndexed: number;
  indexSize: number; // bytes
  lastSyncedAt?: string; // ISO-8601; absent until the first sync completes
  settings?: Record<string, unknown>; // future extensibility
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

/**
 * Object-to-chunk manifest: the authoritative list of vector-store keys for an
 * object, so the system can delete/reindex an object's chunks by explicit key.
 *
 * One query (pk: BUCKET#{orgId}#{region}#{bucketName}, sk begins_with MANIFEST#) returns
 * every object indexed in a bucket.
 *
 * RagIndexerTable — pk: BUCKET#{orgId}#{region}#{bucketName}, sk: MANIFEST#{objectKey}
 */
export interface ObjectChunkManifestRecord {
  pk: string;
  sk: string;
  objectKey: string;
  /** Object version/state id (ETag) used to detect changes and bust the cache. */
  etag: string;
  /** Vector-store keys for this object: objectKey#0, objectKey#1, ... */
  chunkKeys: string[];
  chunkCount: number;
  updatedAt: string; // ISO-8601
}

/**
 * Resumable checkpoint for the RAG indexer worker. A bucket with more objects
 * than one Lambda invocation can process persists its S3 `continuationToken`
 * here so the next run resumes mid-bucket instead of restarting from the top.
 *
 * One active checkpoint per bucket. The row carries a TTL so a stale checkpoint
 * (e.g. a worker that died mid-bucket) eventually expires and the bucket is
 * re-scanned from the beginning rather than being wedged indefinitely.
 *
 * RagIndexerTable — pk: INDEXER_CHECKPOINT#{orgId}#{region}#{bucketName}, sk: CHECKPOINT
 */
export interface RagIndexerCheckpointRecord {
  pk: string;
  sk: string;
  bucketId: string;
  bucketName: string;
  /** S3 continuation token to resume listing from; absent once the bucket is done. */
  continuationToken?: string;
  lastPageStartedAt: string; // ISO-8601, for stale-checkpoint detection
  ttl: number; // epoch seconds; DynamoDB TTL expiry (48h)
}

/**
 * Key builders for the RAG records above. Centralizing the pk/sk shapes keeps
 * the partition design (and the per-bucket `begins_with MANIFEST#` query)
 * consistent across handlers and jobs.
 */
export const RAGKeys = {
  configPk: (orgId: string): string => `ORG#${orgId}`,
  configSk: (): string => 'RAGCONFIG',
  bucketPk: (orgId: string, region: S3Region, bucketName: string): string =>
    `BUCKET#${orgId}#${region}#${bucketName}`,
  /**
   * Inverse of {@link bucketPk}: parse a `BUCKET#{orgId}#{region}#{bucketName}` pk back into
   * its parts. None of the three segments can contain `#` (orgId is a UUID, region is an enum,
   * bucket names are `[a-z0-9-]`), so a clean 4-way split is unambiguous. Returns `undefined`
   * for any pk that is not exactly this shape (wrong prefix, wrong segment count, unknown region,
   * empty orgId or bucket name). Region membership is checked stage-independently (a valid-but-
   * currently-disabled region must still parse), so this does NOT use the stage-aware
   * `isSupportedRegion`.
   */
  parseBucketPk: (
    pk: string,
  ): { orgId: string; region: S3Region; bucketName: string } | undefined => {
    const parts = pk.split('#');
    if (parts.length !== 4 || parts[0] !== 'BUCKET') return undefined;
    const [, orgId, region, bucketName] = parts;
    if (!orgId || !bucketName) return undefined;
    if (!Object.values(S3Region).includes(region as S3Region)) return undefined;
    return { orgId, region: region as S3Region, bucketName };
  },
  enablementSk: (): string => 'RAG',
  /** Shared prefix for `begins_with` queries returning a bucket's manifests. */
  manifestSkPrefix: (): string => 'MANIFEST#',
  manifestSk: (objectKey: string): string => `MANIFEST#${objectKey}`,
  checkpointPk: (orgId: string, region: S3Region, bucketName: string): string =>
    `INDEXER_CHECKPOINT#${orgId}#${region}#${bucketName}`,
  checkpointSk: (): string => 'CHECKPOINT',
} as const;
