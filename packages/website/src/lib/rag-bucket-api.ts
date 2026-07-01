import type {
  BucketRagEnablementResponse,
  ListBucketsResponse,
  QueryBucketResponse,
  S3Region,
  SetBucketRagEnabledRequest,
  BucketRagSyncState,
} from '@filone/shared';
import { apiRequest } from './api.js';

/**
 * Typed client functions for the RAG Pipeline surface (FIL-555). Thin wrappers
 * over {@link apiRequest} mirroring the existing call sites in BucketsPage —
 * keeps the page's TanStack Query hooks free of fetch/serialization details.
 */

/** A bucket joined with its (possibly still-loading) RAG enablement state. */
export type RagBucket = {
  name: string;
  region: S3Region;
  enabled: boolean;
  filesIndexed: number;
  indexSize: number;
  lastSyncedAt?: string;
  /**
   * Sync progress from the indexer (FIL-556); drives the Syncing…/Sync-failed
   * indicator only. Independent of `enabled`: a syncing/errored bucket is still
   * enabled and queryable.
   */
  syncState?: BucketRagSyncState;
  /** Failure reason, present only when `syncState === 'error'`. */
  lastSyncError?: string;
};

/**
 * Stable, collision-free identifier for a bucket. Bucket names are only
 * region-scoped (not globally unique), so `name` alone is unsafe as a React
 * key or state lookup — two buckets sharing a name across regions would
 * collide. Qualify with the region.
 */
export function bucketKey(bucket: Pick<RagBucket, 'name' | 'region'>): string {
  return `${bucket.region}:${bucket.name}`;
}

/** List the caller's buckets — reuses GET /api/buckets. */
export function listBucketsForRag(): Promise<ListBucketsResponse> {
  return apiRequest<ListBucketsResponse>('/buckets');
}

/**
 * Read a bucket's RAG enablement state + sync telemetry.
 *
 * Bucket names are region-scoped (not globally unique), so `region` is required
 * and forwarded to the regional orchestrator via `?region=`.
 */
export function getBucketRagEnabled(
  bucketName: string,
  region: S3Region,
): Promise<BucketRagEnablementResponse> {
  const qs = new URLSearchParams({ region }).toString();
  return apiRequest<BucketRagEnablementResponse>(
    `/buckets/${encodeURIComponent(bucketName)}/rag/enabled?${qs}`,
  );
}

/** Enable or disable RAG indexing on a bucket. */
export function setBucketRagEnabled(
  bucketName: string,
  region: S3Region,
  enabled: boolean,
): Promise<BucketRagEnablementResponse> {
  const body: SetBucketRagEnabledRequest = { enabled };
  const qs = new URLSearchParams({ region }).toString();
  return apiRequest<BucketRagEnablementResponse>(
    `/buckets/${encodeURIComponent(bucketName)}/rag/enabled?${qs}`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

/** Submit a grounded query against a bucket's index (FIL-554). */
export function queryBucket(
  bucketName: string,
  region: S3Region,
  query: string,
  options: { topK?: number; model?: string } = {},
): Promise<QueryBucketResponse> {
  const qs = new URLSearchParams({ region }).toString();
  return apiRequest<QueryBucketResponse>(`/buckets/${encodeURIComponent(bucketName)}/query?${qs}`, {
    method: 'POST',
    body: JSON.stringify({
      query,
      ...(options.topK !== undefined ? { top_k: options.topK } : {}),
      ...(options.model ? { model: options.model } : {}),
    }),
  });
}
