import { z } from 'zod';

/** Default number of chunks retrieved when the caller does not specify `top_k`. */
export const QUERY_DEFAULT_TOP_K = 10;

/** Upper bound on `top_k` to prevent abusive retrieval requests. */
export const QUERY_MAX_TOP_K = 100;

/**
 * Request body accepted by `POST /api/buckets/{name}/query` (FIL-554).
 *
 * `query` is required and must be a non-empty trimmed string. `top_k` must be in
 * [1, {@link QUERY_MAX_TOP_K}] and defaults to {@link QUERY_DEFAULT_TOP_K}.
 * `model` optionally requests a specific Bedrock completion model.
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
