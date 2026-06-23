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

/**
 * Enablement state of a bucket's RAG index — the SOURCE OF TRUTH for whether
 * RAG is on for a bucket. These are the user/operator-controlled lifecycle
 * states only: `active` (RAG on; the indexer scans/indexes it and the UI treats
 * it as queryable), `disabled` (user turned it off), `paused` (operational hold).
 *
 * This field is decoupled from sync progress: the indexer's in-flight/failed
 * state lives on {@link BucketRAGEnablementRecord.syncState} so a bucket that is
 * currently syncing or whose last sync failed is STILL enabled (`active`) and is
 * still scanned/indexed/queryable.
 */
export type BucketRAGStatus = 'active' | 'disabled' | 'paused';

/**
 * Sync progress of a bucket's RAG index, written exclusively by the indexer
 * (FIL-556). Independent of {@link BucketRAGStatus} (enablement): the indexer
 * sets `syncing` at the start of a bucket run, `idle` on a successful full pass,
 * and `error` (with {@link BucketRAGEnablementRecord.lastSyncError}) on failure.
 * Absent/`idle` means never-synced or steady. The indexer NEVER touches the
 * enablement `status`, so liveness (orchestrator scan, worker gate) and the UI
 * enabled-check are unaffected by sync state.
 */
export type BucketRAGSyncState = 'idle' | 'syncing' | 'error';

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
 * Per-bucket RAG enablement, settings, and sync telemetry.
 *
 * UserInfoTable — pk: BUCKET#{region}#{bucketId}, sk: RAG
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
  /**
   * Enablement state — the source of truth for whether RAG is on for this
   * bucket. Written only by the enablement endpoint (FIL-555); the indexer never
   * modifies it. The orchestrator scan, the worker per-bucket gate, and the UI
   * all treat `active` as enabled/queryable, independent of {@link syncState}.
   */
  status: BucketRAGStatus;
  /**
   * Sync progress, written exclusively by the indexer (FIL-556) and decoupled
   * from {@link status}: `syncing` during a run, `idle` after a successful full
   * pass, `error` on failure. Absent means never-synced (rendered as idle). A
   * `syncing`/`error` bucket whose `status` is still `active` remains enabled.
   */
  syncState?: BucketRAGSyncState;
  /**
   * Count of objects with at least one chunk currently indexed — i.e. the size
   * of the chunk manifest after a full reconciliation. Written atomically by the
   * indexer (FIL-556) on a successful sync; 0 until the first sync completes.
   */
  filesIndexed: number;
  /**
   * Index size in bytes, defined as the sum of the source-object bytes (the S3
   * `Size` reported by the listing) of every indexed object. This is the
   * documented, UI-facing measure — NOT the embedding/vector storage size — so
   * the Buckets-tab "index size" label matches what `formatBytes` renders.
   * Written atomically by the indexer (FIL-556); 0 until the first sync.
   */
  indexSize: number;
  lastSyncedAt?: string; // ISO-8601; absent until the first sync completes
  /**
   * Human-readable message from the most recent failed sync. Populated only when
   * `syncState === 'error'` and cleared (removed) when a later sync succeeds.
   */
  lastSyncError?: string;
  settings?: Record<string, unknown>; // future extensibility
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

/**
 * Object-to-chunk manifest: the authoritative list of vector-store keys for an
 * object, so the system can delete/reindex an object's chunks by explicit key.
 *
 * One query (pk: BUCKET#{region}#{bucketId}, sk begins_with MANIFEST#) returns
 * every object indexed in a bucket.
 *
 * UserInfoTable — pk: BUCKET#{region}#{bucketId}, sk: MANIFEST#{objectKey}
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
 * UserInfoTable — pk: INDEXER_CHECKPOINT#{bucketId}, sk: CHECKPOINT
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
  bucketPk: (region: S3Region, bucketName: string): string => `BUCKET#${region}#${bucketName}`,
  /**
   * Inverse of {@link bucketPk}: parse a `BUCKET#{region}#{bucketName}` pk back into its parts.
   * Returns `undefined` for any malformed pk (missing prefix, unknown region, empty bucket name).
   * Region membership is checked stage-independently (a valid-but-currently-disabled region must
   * still parse), so this does NOT use the stage-aware `isSupportedRegion`.
   */
  parseBucketPk: (pk: string): { region: S3Region; bucketName: string } | undefined => {
    const PREFIX = 'BUCKET#';
    if (!pk.startsWith(PREFIX)) return undefined;
    const rest = pk.slice(PREFIX.length);
    const sep = rest.indexOf('#');
    if (sep <= 0) return undefined;
    const region = rest.slice(0, sep);
    const bucketName = rest.slice(sep + 1);
    if (!bucketName) return undefined;
    if (!Object.values(S3Region).includes(region as S3Region)) return undefined;
    return { region: region as S3Region, bucketName };
  },
  enablementSk: (): string => 'RAG',
  /** Shared prefix for `begins_with` queries returning a bucket's manifests. */
  manifestSkPrefix: (): string => 'MANIFEST#',
  manifestSk: (objectKey: string): string => `MANIFEST#${objectKey}`,
  checkpointPk: (region: S3Region, bucketName: string): string =>
    `INDEXER_CHECKPOINT#${region}#${bucketName}`,
  checkpointSk: (): string => 'CHECKPOINT',
} as const;
