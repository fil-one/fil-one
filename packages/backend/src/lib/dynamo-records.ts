import { S3Region } from '@filone/shared';
import type {
  BulkDeleteFailure,
  BulkDeleteJobStatus,
  BulkDeleteScope,
  SubscriptionStatus,
} from '@filone/shared';

/**
 * The era a key was minted in.
 *
 * `pre-member-scope` records one fact: the key was created after the role
 * vocabulary existed and before member bucket scope is enforced. It does not
 * claim a cap was applied — the permission cap ships with enforcement, and
 * bucket scope does not exist until FIL-1017, whose keys get the next value in
 * this union. Keys older than roles carry no marker at all, and both cohorts
 * are what the non-conforming-key review has to find. None of it is
 * backfillable, which is why the marker ships now rather than with the surfaces
 * that read it.
 */
export type AccessKeyPolicyVersion = 'pre-member-scope';

export const ACCESS_KEY_POLICY_VERSION: AccessKeyPolicyVersion = 'pre-member-scope';

/**
 * Every key an access-key row is addressed by, in one builder.
 *
 * The handlers built these strings by hand in five places, which is how a
 * mint and a revoke end up disagreeing about where a key lives.
 */
const ACCESS_KEY_SK_PREFIX = 'ACCESSKEY#';

export const AccessKeyKeys = {
  orgPk: (orgId: string): string => `ORG#${orgId}`,
  keySk: (keyId: string): string => `${ACCESS_KEY_SK_PREFIX}${keyId}`,
  /** For the Query that lists an org's keys. */
  keySkPrefix: (): string => ACCESS_KEY_SK_PREFIX,
} as const;

/** UserInfoTable — pk: ORG#{orgId}, sk: ACCESSKEY#{id} */
export interface AccessKeyRecord {
  pk: string;
  sk: string;
  keyName: string;
  accessKeyId: string;
  createdAt: string;
  status: string;
  /** The FilOne user who minted the key. Absent on keys older than roles. */
  createdBy?: string;
  /** The creator's verified email at creation time, for display without a join. */
  creatorEmail?: string;
  /** See {@link AccessKeyPolicyVersion}. */
  policyVersion?: AccessKeyPolicyVersion;
  /**
   * Set when the row was reconstructed from the provider after a partial
   * failure, so its attribution names the caller who retried rather than a
   * confirmed creator. See `recoverDuplicateKey`.
   */
  recovered?: boolean;
}

/**
 * Who minted a key and under what policy, for the row's attribution
 * attributes. The email is verified-only, matching the RAG-key shape: an
 * unverified address must never be the name attached to a credential.
 */
export function keyAttribution({
  userId,
  creatorEmail,
}: {
  userId: string;
  creatorEmail?: string;
}): Pick<AccessKeyRecord, 'createdBy' | 'creatorEmail' | 'policyVersion'> {
  return {
    createdBy: userId,
    ...(creatorEmail ? { creatorEmail } : {}),
    policyVersion: ACCESS_KEY_POLICY_VERSION,
  };
}

/**
 * The Stripe price a subscription is billed on. Only fields that are immutable
 * on a Stripe price are kept — mutable ones (`nickname`, `active`, `metadata`,
 * `lookup_key`) are dropped, so a copy of this shape can never drift from
 * Stripe no matter how long we hold it. Field names mirror the Stripe API.
 */
export interface StripePriceDetails {
  id: string;
  product?: string;
  /**
   * The product's display name, cached alongside the price so a Stripe outage
   * does not cost the customer the name of their own plan. Snake_case with the
   * rest of this interface, which mirrors Stripe's field names.
   */
  product_name?: string;
  currency?: string;
  billing_scheme?: 'per_unit' | 'tiered';
  tiers_mode?: 'graduated' | 'volume' | null;
  unit_amount?: number | null;
  /** Set instead of `unit_amount` for sub-cent rates, e.g. '0.499' per GB. */
  unit_amount_decimal?: string | null;
  tiers?: Array<{
    up_to: number | null;
    flat_amount: number | null;
    flat_amount_decimal: string | null;
    unit_amount: number | null;
    unit_amount_decimal: string | null;
  }>;
  recurring?: {
    interval?: string;
    interval_count?: number;
    usage_type?: string;
    meter?: string | null;
  } | null;
}

/**
 * BillingTable — pk: `ORG#{orgId}`, sk: SUBSCRIPTION (ADR §5). Read and written
 * through `lib/subscription-store.ts`, never keyed inline.
 */
export interface SubscriptionRecord {
  pk: string;
  sk: string;
  /**
   * The org the subscription belongs to — the partition key, and required.
   * One org, one subscription: a row without this is not addressable, which is
   * why the re-key's verification enumerated every such row and had each
   * dispositioned by name before the flip merged.
   */
  orgId: string;
  /**
   * The member who owns the Stripe customer. An attribute rather than part of
   * the key, so the self-healing paths that close out a deleted Stripe customer
   * still have a user to name.
   */
  userId?: string;
  stripeCustomerId?: string;
  subscriptionStatus?: SubscriptionStatus;
  subscriptionId?: string;
  trialEndsAt?: string;
  gracePeriodEndsAt?: string;
  /** The billing period the meter reports against; written with the period end. */
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  canceledAt?: string;
  /**
   * The deletion teardown's revive fence, an ISO timestamp the scrub stamps
   * with `if_not_exists`. Every guarded subscription writer refuses a row
   * carrying it (`attribute_not_exists(deletedAt)` via `guardAgainstScrub`),
   * so a late webhook cannot revive a scrubbed org.
   */
  deletedAt?: string;
  lastPaymentFailedAt?: string;
  /**
   * What `hubspot-contact-sync` knows about this row's HubSpot contact.
   *
   * `hubspotSyncedAt` is when the job last attempted the row, whatever came of
   * it, and is what its scan filter gates on — so a contact HubSpot cannot
   * match waits out the re-verify window like any other rather than being
   * retried on every run. `hubspotSubscriptionStatus` is the value HubSpot
   * confirmed holding, absent when it holds no contact for this user; the job
   * selects on it disagreeing with `subscriptionStatus` to repair a dropped
   * live write.
   */
  hubspotSubscriptionStatus?: SubscriptionStatus;
  hubspotSyncedAt?: string;
  paymentMethodId?: string;
  paymentMethodLast4?: string;
  paymentMethodBrand?: string;
  paymentMethodExpMonth?: number;
  paymentMethodExpYear?: number;
  /**
   * Cached so we can still report what the customer pays when the Stripe API is
   * unavailable. Rewritten only when the price id changes.
   */
  stripePrice?: StripePriceDetails;
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
  /**
   * Owning org and region, denormalized onto the row (as with
   * {@link BucketRAGEnablementRecord}) so the persisted shape matches this type
   * rather than relying on the values embedded in the pk.
   */
  orgId: string;
  region: S3Region;
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

/**
 * A user-initiated bulk deletion of a bucket's objects, resumable across Lambda
 * invocations the way {@link RagIndexerCheckpointRecord} is: the worker persists
 * its listing cursor whenever it runs out of time budget, then re-invokes itself
 * and picks up where it stopped.
 *
 * `jobId` is the caller's idempotency key, so a retried create resolves to the
 * same row and a conditional put is all the protection needed against a double
 * submit starting a second deletion.
 *
 * BulkDeleteTable — pk: BULKDELETE#{orgId}, sk: JOB#{jobId}
 */
export interface BulkDeleteJobRecord {
  pk: string;
  sk: string;
  jobId: string;
  orgId: string;
  region: S3Region;
  bucketName: string;
  /** Empty string means the whole bucket. */
  prefix: string;
  scope: BulkDeleteScope;
  status: BulkDeleteJobStatus;
  deletedCount: number;
  failedCount: number;
  /** Bounded sample; `failedCount` is the authoritative total. */
  failures: BulkDeleteFailure[];
  /** Listing resume point; absent once the walk is exhausted. */
  cursor?: BulkDeleteCursorRecord;
  /**
   * Hand-offs made so far. Doubles as the deduplication id of the job's next
   * queue message, so it must be persisted before that message is sent.
   */
  resumeCount?: number;
  startedAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  completedAt?: string; // ISO-8601
  /** Present when status is `failed`. */
  error?: string;
  ttl: number; // epoch seconds; DynamoDB TTL expiry
}

/** Persisted form of the S3 listing cursor (see s3-bulk-delete). */
export interface BulkDeleteCursorRecord {
  continuationToken?: string;
  keyMarker?: string;
  versionIdMarker?: string;
}

export const BulkDeleteKeys = {
  jobPk: (orgId: string): string => `BULKDELETE#${orgId}`,
  jobSk: (jobId: string): string => `JOB#${jobId}`,
} as const;
