import type {
  BucketRagEnablementResponse,
  ListBucketsResponse,
  QueryBucketResponse,
  SetBucketRagEnabledRequest,
} from '@filone/shared';
import { apiRequest } from './api.js';

/**
 * Typed client functions for the RAG Pipeline surface (FIL-555). Thin wrappers
 * over {@link apiRequest} mirroring the existing call sites in BucketsPage —
 * keeps the page's TanStack Query hooks free of fetch/serialization details.
 */

/** List the caller's buckets — reuses GET /api/buckets. */
export function listBucketsForRag(): Promise<ListBucketsResponse> {
  return apiRequest<ListBucketsResponse>('/buckets');
}

/** Read a bucket's RAG enablement state + sync telemetry. */
export function getBucketRagEnabled(bucketName: string): Promise<BucketRagEnablementResponse> {
  return apiRequest<BucketRagEnablementResponse>(
    `/buckets/${encodeURIComponent(bucketName)}/rag/enabled`,
  );
}

/** Enable or disable RAG indexing on a bucket. */
export function setBucketRagEnabled(
  bucketName: string,
  enabled: boolean,
): Promise<BucketRagEnablementResponse> {
  const body: SetBucketRagEnabledRequest = { enabled };
  return apiRequest<BucketRagEnablementResponse>(
    `/buckets/${encodeURIComponent(bucketName)}/rag/enabled`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

/** Submit a grounded query against a bucket's index (FIL-554). */
export function queryBucket(
  bucketName: string,
  query: string,
  options: { topK?: number; model?: string } = {},
): Promise<QueryBucketResponse> {
  return apiRequest<QueryBucketResponse>(`/buckets/${encodeURIComponent(bucketName)}/query`, {
    method: 'POST',
    body: JSON.stringify({
      query,
      ...(options.topK !== undefined ? { top_k: options.topK } : {}),
      ...(options.model ? { model: options.model } : {}),
    }),
  });
}
