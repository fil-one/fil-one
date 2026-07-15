import type { VectorQueryResult, VectorStoreChunk } from './schemas.js';

/**
 * Options accepted by {@link VectorStore.ensureIndex}.
 */
export interface EnsureIndexOptions {
  /** Vector dimensionality. Defaults to {@link EMBEDDING_DIMENSION}. */
  dimension?: number;
  /** Distance metric. Only `'cosine'` is supported and it is immutable per index. */
  distance?: 'cosine';
}

/**
 * Options accepted by {@link VectorStore.query}. Carries the query vector
 * alongside the search parameters so the index-identity args (orgId, region,
 * bucketName) stay a clean triple.
 */
export interface QueryOptions {
  /** The query embedding to search for nearest neighbours of. */
  embedding: number[];
  /** Maximum number of results to return, ordered closest-first. */
  k: number;
  /** Filters applied against filterable metadata. */
  filters?: Record<string, unknown>;
}

/**
 * Store-agnostic abstraction over a vector database used by the RAG feature.
 *
 * There is one index per RAG-enabled bucket. Bucket names are globally
 * namespaced and can be reused across tenants, so the index is identified by the
 * `(orgId, region, bucketName)` triple on every method — never by
 * `(region, bucketName)` alone, which would let a reused name resolve to another
 * tenant's index (FIL-596). Implementations map these operations onto a concrete
 * backend (e.g. a per-bucket companion index bucket of plain S3 objects — see
 * {@link BucketObjectVectorStore}).
 *
 * Conventions enforced by implementations:
 *   - Vector keys are `${objectKey}#${chunkIndex}`.
 *   - `objectKey` is stored as filterable metadata; `text` is non-filterable.
 *   - Per-vector metadata must not exceed 40KB once serialized.
 */
export interface VectorStore {
  /**
   * Idempotently create the index for `(orgId, region, bucketName)`. Calling
   * this when the index already exists must not throw.
   */
  ensureIndex(
    orgId: string,
    region: string,
    bucketName: string,
    options?: EnsureIndexOptions,
  ): Promise<void>;

  /**
   * Insert or overwrite the given chunks. Each chunk must carry an `embedding`.
   * Rejects a chunk whose serialized metadata exceeds 40KB.
   */
  upsertChunks(
    orgId: string,
    region: string,
    bucketName: string,
    chunks: VectorStoreChunk[],
  ): Promise<void>;

  /**
   * Delete vectors by their explicit keys. There is no delete-by-filter path.
   */
  deleteChunks(orgId: string, region: string, bucketName: string, keys: string[]): Promise<void>;

  /**
   * k-NN search over the index, returning up to `options.k` results ordered from
   * closest to farthest match (lower `score`/distance = more similar).
   * `options.filters` are applied against filterable metadata.
   */
  query(
    orgId: string,
    region: string,
    bucketName: string,
    options: QueryOptions,
  ): Promise<VectorQueryResult[]>;

  /**
   * Drop the index for `(orgId, region, bucketName)` and all of its vectors.
   */
  dropIndex(orgId: string, region: string, bucketName: string): Promise<void>;
}
