import { z } from 'zod';

/** Default number of chunks retrieved when the caller does not specify `top_k`. */
export const QUERY_DEFAULT_TOP_K = 10;

/** Upper bound on `top_k` to prevent abusive retrieval requests. */
export const QUERY_MAX_TOP_K = 100;

/**
 * Request body accepted by `POST /api/buckets/{name}/query` (FIL-554).
 *
 * `query` is required and must be a non-empty trimmed string. `top_k` is
 * clamped to [1, {@link QUERY_MAX_TOP_K}] and defaults to
 * {@link QUERY_DEFAULT_TOP_K}. `model` optionally overrides the default Bedrock
 * completion model.
 */
export const QueryBucketSchema = z.object({
  query: z.string().trim().min(1, 'Query is required'),
  top_k: z
    .number()
    .int('top_k must be an integer')
    .min(1, 'top_k must be at least 1')
    .max(QUERY_MAX_TOP_K, `top_k must be at most ${QUERY_MAX_TOP_K}`)
    .optional()
    .default(QUERY_DEFAULT_TOP_K),
  model: z.string().trim().min(1, 'model must be a non-empty string').optional(),
});

export interface QueryBucketRequest {
  query: string;
  top_k?: number;
  model?: string;
}

export interface QueryBucketResponse {
  /** The grounded answer generated from the retrieved chunks. */
  answer: string;
  /** Deduplicated source object keys of the retrieved chunks. */
  sources: string[];
}

/**
 * Enablement state of a bucket's RAG index, exposed to the frontend.
 *
 * Mirrors the backend `BucketRAGStatus` (the source of truth for enablement):
 * `active` means indexing is on and the bucket is queryable, `disabled` means
 * the user turned it off, and `paused` is a transient operational hold. A bucket
 * with no enablement record is reported as `disabled`. This is decoupled from
 * sync progress — see {@link BucketRagSyncState}.
 */
export type BucketRagStatus = 'active' | 'disabled' | 'paused';

/**
 * Sync progress of a bucket's RAG index, exposed to the frontend and written by
 * the indexer (FIL-556). Mirrors the backend `BucketRAGSyncState` and is
 * INDEPENDENT of {@link BucketRagStatus}: `syncing` while a reconciliation is in
 * flight, `error` when the last run failed (see `lastSyncError`), `idle`/absent
 * when steady or never-synced. A `syncing`/`error` bucket whose `status` is
 * still `active` remains enabled and queryable; the UI only uses this to render
 * the Syncing…/Sync-failed indicator.
 */
export type BucketRagSyncState = 'idle' | 'syncing' | 'error';

/**
 * Request body for `POST /api/buckets/{name}/rag/enabled` (FIL-555).
 *
 * `enabled` toggles per-bucket RAG indexing on (`true` → status `active`) or
 * off (`false` → status `disabled`).
 */
export const SetBucketRagEnabledSchema = z.object({
  enabled: z.boolean(),
});

export interface SetBucketRagEnabledRequest {
  enabled: boolean;
}

/**
 * Per-bucket RAG enablement + sync telemetry returned by both the GET (read)
 * and POST (write) enablement endpoints (FIL-555).
 *
 * `status`/`enabled` are the enablement source of truth (independent of sync
 * progress). Telemetry fields (`filesIndexed`, `indexSize`, `lastSyncedAt`, and
 * the `syncState`/`lastSyncError` sync indicator) are written by the indexer
 * (FIL-556) and are absent/zero until the first sync completes — callers must
 * render a "Not yet synced" state gracefully. `enabled` is the convenience
 * boolean (`status === 'active'`). `indexSize` is the sum of indexed
 * source-object bytes (the documented measure surfaced via `formatBytes`).
 */
export interface BucketRagEnablementResponse {
  /** Convenience flag: `true` when `status === 'active'`. */
  enabled: boolean;
  /** Enablement state (source of truth); independent of {@link syncState}. */
  status: BucketRagStatus;
  /**
   * Sync progress from the indexer; independent of {@link status}. Absent means
   * never-synced/idle. The UI renders Syncing…/Sync-failed from this WITHOUT
   * changing whether the bucket is treated as enabled.
   */
  syncState?: BucketRagSyncState;
  /** Number of files currently indexed; 0 until the first sync completes. */
  filesIndexed: number;
  /** Index size in bytes (sum of indexed source-object bytes); 0 until the first sync. */
  indexSize: number;
  /** ISO-8601 timestamp of the last successful sync; absent until first sync. */
  lastSyncedAt?: string;
  /**
   * Message from the most recent failed sync. Present only when
   * `syncState === 'error'`; the UI surfaces it as the sync-failed reason.
   */
  lastSyncError?: string;
}
