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

/**
 * The Stripe price a subscription is billed on. Only fields that are immutable
 * on a Stripe price are kept — mutable ones (`nickname`, `active`, `metadata`,
 * `lookup_key`) are dropped, so a copy of this shape can never drift from
 * Stripe no matter how long we hold it. Field names mirror the Stripe API.
 */
export interface StripePriceDetails {
  id: string;
  product?: string;
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

/** BillingTable — pk: CUSTOMER#{userId}, sk: SUBSCRIPTION */
export interface SubscriptionRecord {
  pk: string;
  sk: string;
  /**
   * The org this billing record belongs to, stamped by
   * `lib/create-billing-trial.ts` on both the customer and the subscription
   * write. Absent on rows written before it did.
   */
  orgId?: string;
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
 * Short-lived email verification challenge for account deletion (FIL-112).
 * One live challenge per org; re-issuing replaces the code. Lives in
 * BillingTable because that table has DynamoDB TTL enabled (UserInfoTable
 * deliberately does not — a stray `ttl` attribute on an identity row would
 * silently hard-delete account data).
 *
 * BillingTable — pk: DELETION_CHALLENGE#{orgId}, sk: CHALLENGE
 */
export interface DeletionChallengeRecord {
  pk: string;
  sk: string;
  /** hex sha256 of `${orgId}:${userId}:${salt}:${code}` — never the code itself. */
  codeHash: string;
  /** 16 random bytes, hex. */
  salt: string;
  /** Verify attempts consumed; the record locks at the max. */
  attempts: number;
  /** Codes issued against this row within its TTL window. */
  sendCount: number;
  lastSentAt: string; // ISO-8601 — resend cooldown anchor
  expiresAt: string; // ISO-8601 — code validity, checked in ConditionExpressions
  createdAt: string; // ISO-8601
  ttl: number; // epoch seconds; DynamoDB TTL janitor (~1h)
}

/**
 * Teardown states for {@link OrgDeletionRecord}. Only these two are written:
 * every external teardown step is idempotent, so the worker just re-runs
 * everything until it completes — no per-step tracking. Legacy records may
 * still carry an old intermediate status (KEYS_REVOKED, TENANTS_DISABLED,
 * STRIPE_CANCELED, AUTH0_DELETED, RAG_PURGED, RECORDS_PURGED); readers treat
 * anything that is not DONE as "in progress".
 */
export const OrgDeletionStatus = {
  Pending: 'PENDING',
  Done: 'DONE',
} as const;

/** What started a teardown: the user confirming in-app, or Stripe deleting the customer. */
export type OrgDeletionReason = 'self_serve' | 'stripe_customer_deleted';

/** Snapshot of an org member captured when deletion is confirmed. */
export interface OrgDeletionMember {
  userId: string;
  /**
   * Auth0 sub. Retained on the audit record even after teardown completes:
   * the SUB# identity tombstone keeps the sub forever anyway (it is the key
   * that stops a stale session resurrecting the account), so stripping it
   * here would buy no privacy while breaking audit correlation.
   */
  sub?: string;
}

/**
 * Resumable state record for the account-deletion worker (FIL-112). Written by
 * the delete-account handler at confirm time; snapshots everything the worker
 * needs (tenant ids, member subs) so teardown can finish even after the source
 * rows are purged. Survives the purge as the audit record.
 *
 * Deliberately carries NO Stripe customer snapshot: a confirm-time snapshot
 * cannot see a customer minted inside the deletion race windows, which left
 * that customer's PII in Stripe forever. Teardown discovers the org's Stripe
 * customer live instead — see lib/billing-customer-discovery.ts.
 *
 * UserInfoTable — pk: ORG#{orgId}, sk: DELETION
 */
export interface OrgDeletionRecord {
  pk: string;
  sk: string;
  /**
   * {@link OrgDeletionStatus} value on records written by current code, but
   * typed as string because legacy records may persist old intermediate
   * statuses — compare against `OrgDeletionStatus.Done` only, never
   * exhaustive-switch.
   */
  status: string;
  requestedAt: string; // ISO-8601
  /** Confirming admin, or the `stripe-webhook` sentinel when Stripe triggered it. */
  requestedByUserId: string;
  /** What triggered the teardown; absent on records written before FIL-112's webhook path. */
  reason?: OrgDeletionReason;
  members: OrgDeletionMember[];
  /**
   * Region-generic tenant snapshot: orchestrator id → tenant id for every
   * region provisioned when deletion was confirmed (refreshed with any
   * late-provisioned tenants before the ORG# partition purge). The only
   * tenant-id shape written going forward.
   */
  tenantIds?: Record<string, string>;
  /**
   * Stripe customer id → the Redaction Job erasing that customer's PII,
   * persisted at creation so retries advance the same job instead of creating
   * duplicates. Keyed by customer because a teardown can face more than one: a
   * resurrection (`createBillingTrial` landing after the purge) mints a NEW
   * customer, and redacting it must not be short-circuited by the job covering
   * the original.
   */
  stripeRedactionJobIds?: Record<string, string>;
  /**
   * Stripe customers discovered by a resweep that the tombstone does not name —
   * i.e. minted AFTER this org's teardown completed. Durable audit trail for
   * the follow-up, kept on the record that is retained forever. Non-empty means
   * a fence gap let a writer resurrect billing for a deleted account.
   *
   * APPENDED to, never overwritten, so two overlapping resweeps cannot drop
   * each other's finding — which means it may hold duplicates. Every reader
   * dedupes; see {@link pendingRedactionCustomerIds}.
   */
  resurrectedStripeCustomerIds?: string[];
  /**
   * Stripe customer id → the TERMINAL status its Redaction Job reached. Only
   * terminal values are ever written, so an entry means "Stripe will not move
   * this job again"; a resurrected customer with no entry still needs driving.
   *
   * This is what gives a resweep's Stripe tail a durable driver. A resweep
   * purges the org's DynamoDB residue — which is the evidence the resurrection
   * sweep otherwise works from — so once the purge succeeds, an unfinished
   * redaction job would be driven only by Lambda's two bounded async retries
   * and then by nothing at all, leaving the resurrected customer's PII in
   * Stripe forever. Keyed here, the sweep re-drives the org from the record
   * alone. See {@link pendingRedactionCustomerIds}.
   */
  stripeRedactionJobStatuses?: Record<string, string>;
  /**
   * When the record purge first completed — the fences were up and the purge
   * was done, so from here on every writer that consults the fence is refused.
   * Not an absolute cutoff: a request that read the profile before the fence
   * landed can still mint afterwards, bounded by API Gateway's 29s timeout.
   * The teardown waits out Stripe's search-index lag from HERE, not from
   * `requestedAt`, so it must survive across passes; the earliest value wins.
   * Absent on legacy records and until the first purge completes.
   */
  purgedAt?: string;
  /** Worker invocations so far; the orchestrator alerts past a threshold. */
  attemptCount: number;
  /**
   * Last user-triggered re-drive of the teardown worker, written by
   * `claimDeletionRedrive` to throttle them. Never a liveness signal — see
   * `lib/deletion-record.ts`.
   */
  lastRedriveAt?: string;
  updatedAt: string; // ISO-8601
}

/**
 * Redaction-job statuses Stripe never moves a job out of. `redacting` counts:
 * redaction is irreversible once it starts. `unavailable` is OURS, not
 * Stripe's — the customer no longer exists, so there is nothing left to redact
 * and no later pass could do anything different.
 *
 * Anything else (`created`, `validating`, `ready`, or a status Stripe adds
 * later) is deliberately non-terminal: the sweep keeps re-driving the org until
 * the job lands in this set, so a status we do not understand errs toward
 * driving it rather than toward silently giving up on the erasure.
 */
export const TERMINAL_REDACTION_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'redacting',
  'failed',
  'canceled',
  'unavailable',
]);

/**
 * The terminal statuses that mean the PII was NOT erased. Terminal stops the
 * re-drive loop, so these have to be surfaced instead — the orchestrator emits
 * `DeletionRedactionFailedCount` for them.
 */
export const FAILED_REDACTION_STATUSES: ReadonlySet<string> = new Set(['failed', 'canceled']);

/** The {@link OrgDeletionRecord} fields the two predicates below read. */
export type RedactionProgress = Pick<
  OrgDeletionRecord,
  'resurrectedStripeCustomerIds' | 'stripeRedactionJobStatuses'
>;

/**
 * Resurrected Stripe customers whose Redaction Job has not reached a terminal
 * status — the record's own answer to "is this org's Stripe tail still
 * outstanding?", and the resurrection sweep's only durable driver for it.
 *
 * Deduped, because `resurrectedStripeCustomerIds` is appended to rather than
 * overwritten.
 *
 * Only RESURRECTED customers are tracked. The original customer's redaction is
 * driven by the ordinary teardown, whose record stays non-DONE until it
 * settles; a resweep's record is already DONE, so nothing else is left to keep
 * the org being re-driven.
 */
export function pendingRedactionCustomerIds(record: RedactionProgress): string[] {
  const statuses = record.stripeRedactionJobStatuses ?? {};
  return [...new Set(record.resurrectedStripeCustomerIds ?? [])].filter(
    (customerId) => !TERMINAL_REDACTION_STATUSES.has(statuses[customerId] ?? ''),
  );
}

/** Resurrected customers whose redaction ended terminally WITHOUT erasing the PII. */
export function failedRedactionCustomerIds(record: RedactionProgress): string[] {
  const statuses = record.stripeRedactionJobStatuses ?? {};
  return [...new Set(record.resurrectedStripeCustomerIds ?? [])].filter((customerId) =>
    FAILED_REDACTION_STATUSES.has(statuses[customerId] ?? ''),
  );
}

/**
 * Permanent, PII-free marker that an org was deleted, retaining the Stripe
 * customer reference for finance/audit (the Stripe customer is kept, only the
 * subscription is canceled). No `ttl` attribute — never expires.
 *
 * BillingTable — pk: ORG_TOMBSTONE#{orgId}, sk: TOMBSTONE
 */
export interface OrgTombstoneRecord {
  pk: string;
  sk: string;
  orgId: string;
  /** The org's Stripe customer, 1:1 by domain; absent when it never had one. */
  stripeCustomerId?: string;
  deletedAt: string; // ISO-8601
}

/** Key builders for the account-deletion records above. */
export const DeletionKeys = {
  challengePk: (orgId: string): string => `DELETION_CHALLENGE#${orgId}`,
  challengeSk: (): string => 'CHALLENGE',
  deletionPk: (orgId: string): string => `ORG#${orgId}`,
  deletionSk: (): string => 'DELETION',
  tombstonePk: (orgId: string): string => `ORG_TOMBSTONE#${orgId}`,
  tombstoneSk: (): string => 'TOMBSTONE',
} as const;

/**
 * The usage-reporting worker's BillingTable audit rows, hanging off the org's
 * `ORG#{orgId}` partition. Shared by the writer and the teardown's purge: if the
 * two definitions drifted, the rows would survive a completed deletion until
 * their 365-day TTL.
 */
export const UsageReportKeys = {
  skPrefix: 'USAGE_REPORT#',
  sk: (reportDate: string): string => `USAGE_REPORT#${reportDate}`,
} as const;

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
