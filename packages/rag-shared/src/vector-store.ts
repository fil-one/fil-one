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
   * k-NN similarity search over the index, returning up to `k` results ordered
   * by similarity. `filters` are applied against filterable metadata.
   */
  query(
    region: string,
    bucketName: string,
    embedding: number[],
    k: number,
    filters?: Record<string, unknown>,
  ): Promise<VectorQueryResult[]>;

  /**
   * Drop the index for `(region, bucketName)` and all of its vectors.
   */
  dropIndex(region: string, bucketName: string): Promise<void>;
}
