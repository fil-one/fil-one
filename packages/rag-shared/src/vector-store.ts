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
 * Options accepted by {@link VectorStore.query}.
 */
export interface QueryOptions {
  /** Maximum number of results to return, ordered closest-first. */
  k: number;
  /** Filters applied against filterable metadata. */
  filters?: Record<string, unknown>;
}

/**
 * Store-agnostic abstraction over a vector database used by the RAG feature.
 *
 * There is one index per RAG-enabled bucket. Because S3 bucket names are unique
 * per region but not globally, the index is identified by the `(region,
 * bucketName)` pair on every method, not by `bucketName` alone. Implementations
 * map these operations onto a concrete backend (e.g. Amazon S3 Vectors).
 *
 * Conventions enforced by implementations:
 *   - Vector keys are `${objectKey}#${chunkIndex}`.
 *   - `objectKey` is stored as filterable metadata; `text` is non-filterable.
 *   - Per-vector metadata must not exceed 40KB once serialized.
 */
export interface VectorStore {
  /**
   * Idempotently create the index for `(region, bucketName)`. Calling this when
   * the index already exists must not throw.
   */
  ensureIndex(region: string, bucketName: string, options?: EnsureIndexOptions): Promise<void>;

  /**
   * Insert or overwrite the given chunks. Each chunk must carry an `embedding`.
   * Rejects a chunk whose serialized metadata exceeds 40KB.
   */
  upsertChunks(region: string, bucketName: string, chunks: VectorStoreChunk[]): Promise<void>;

  /**
   * Delete vectors by their explicit keys. There is no delete-by-filter path.
   */
  deleteChunks(region: string, bucketName: string, keys: string[]): Promise<void>;

  /**
   * k-NN search over the index, returning up to `options.k` results ordered from
   * closest to farthest match (lower `score`/distance = more similar).
   * `options.filters` are applied against filterable metadata.
   */
  query(
    region: string,
    bucketName: string,
    embedding: number[],
    options: QueryOptions,
  ): Promise<VectorQueryResult[]>;

  /**
   * Drop the index for `(region, bucketName)` and all of its vectors.
   */
  dropIndex(region: string, bucketName: string): Promise<void>;
}
