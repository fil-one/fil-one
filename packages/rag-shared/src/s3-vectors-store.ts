import {
  ConflictException,
  CreateIndexCommand,
  DeleteIndexCommand,
  DeleteVectorsCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
  S3VectorsClient,
} from '@aws-sdk/client-s3vectors';
import type { DocumentType } from '@smithy/types';

import { EMBEDDING_DIMENSION, MAX_METADATA_BYTES } from './constants.js';
import type { VectorQueryResult, VectorStoreChunk } from './schemas.js';
import type { EnsureIndexOptions, VectorStore } from './vector-store.js';

/**
 * Metadata key under which the chunk's `objectKey` is stored. It is left
 * filterable so callers can scope queries (and so manifests can be reconciled).
 */
const OBJECT_KEY_METADATA = 'objectKey';

/**
 * Metadata key under which the chunk's raw text is stored. It is registered as
 * non-filterable at index creation time: it can be retrieved but never queried.
 */
const TEXT_METADATA = 'text';

/**
 * Amazon S3 Vectors implementation of {@link VectorStore}.
 *
 * A single S3 Vectors *vector bucket* (provisioned in `sst.config.ts` and read
 * at runtime via `Resource.RagVectorBucket.name`) hosts one *index* per
 * RAG-enabled bucket. Because bucket names are unique per region but not
 * globally, each index is named by the `(region, bucketName)` pair so
 * same-named buckets in different regions do not collide on one index.
 *
 * Uses the default AWS SDK credential chain (SigV4 via the Lambda execution
 * role); no VPC configuration.
 */
export class S3VectorsStore implements VectorStore {
  readonly #vectorBucketName: string;
  readonly #client: S3VectorsClient;

  constructor(vectorBucketName: string, client?: S3VectorsClient) {
    if (!vectorBucketName) {
      throw new Error('S3VectorsStore requires a vector bucket name');
    }
    this.#vectorBucketName = vectorBucketName;
    this.#client = client ?? new S3VectorsClient({});
  }

  async ensureIndex(
    region: string,
    bucketName: string,
    options?: EnsureIndexOptions,
  ): Promise<void> {
    const dimension = options?.dimension ?? EMBEDDING_DIMENSION;
    try {
      await this.#client.send(
        new CreateIndexCommand({
          vectorBucketName: this.#vectorBucketName,
          indexName: this.#indexName(region, bucketName),
          dataType: 'float32',
          dimension,
          // Distance metric is immutable once the index exists.
          distanceMetric: options?.distance ?? 'cosine',
          metadataConfiguration: {
            // `text` is retrievable but cannot be used as a query filter.
            nonFilterableMetadataKeys: [TEXT_METADATA],
          },
        }),
      );
    } catch (error) {
      // Idempotent: an existing index surfaces as a ConflictException.
      if (error instanceof ConflictException) {
        return;
      }
      throw error;
    }
  }

  async upsertChunks(
    region: string,
    bucketName: string,
    chunks: VectorStoreChunk[],
  ): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const vectors = chunks.map((chunk) => {
      if (!chunk.embedding) {
        throw new Error(`Chunk "${chunk.key}" is missing an embedding`);
      }

      const metadata: DocumentType = {
        ...chunk.metadata,
        [OBJECT_KEY_METADATA]: objectKeyFromChunkKey(chunk.key),
        [TEXT_METADATA]: chunk.text,
      } as DocumentType;

      let metadataJson: string;
      try {
        metadataJson = JSON.stringify(metadata);
      } catch {
        throw new Error(`Chunk "${chunk.key}" metadata is not JSON-serializable`);
      }
      const metadataBytes = Buffer.byteLength(metadataJson, 'utf8');
      if (metadataBytes > MAX_METADATA_BYTES) {
        throw new Error(
          `Chunk "${chunk.key}" metadata is ${metadataBytes} bytes, ` +
            `exceeding the ${MAX_METADATA_BYTES} byte (40KB) per-vector limit`,
        );
      }

      return {
        key: chunk.key,
        data: { float32: chunk.embedding },
        metadata,
      };
    });

    await this.#client.send(
      new PutVectorsCommand({
        vectorBucketName: this.#vectorBucketName,
        indexName: this.#indexName(region, bucketName),
        vectors,
      }),
    );
  }

  async deleteChunks(region: string, bucketName: string, keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    await this.#client.send(
      new DeleteVectorsCommand({
        vectorBucketName: this.#vectorBucketName,
        indexName: this.#indexName(region, bucketName),
        keys,
      }),
    );
  }

  async query(
    region: string,
    bucketName: string,
    embedding: number[],
    k: number,
    filters?: Record<string, unknown>,
  ): Promise<VectorQueryResult[]> {
    const response = await this.#client.send(
      new QueryVectorsCommand({
        vectorBucketName: this.#vectorBucketName,
        indexName: this.#indexName(region, bucketName),
        topK: k,
        queryVector: { float32: embedding },
        returnMetadata: true,
        returnDistance: true,
        ...(filters ? { filter: filters as DocumentType } : {}),
      }),
    );

    return (response.vectors ?? [])
      .map((vector) => {
        if (!vector.key || vector.distance === null) {
          return null;
        }

        const metadata = { ...((vector.metadata ?? {}) as Record<string, unknown>) };
        const text = typeof metadata[TEXT_METADATA] === 'string' ? metadata[TEXT_METADATA] : '';
        delete metadata[TEXT_METADATA];

        return {
          key: vector.key,
          text,
          metadata,
          score: vector.distance,
        };
      })
      .filter((vector): vector is VectorQueryResult => vector !== null);
  }

  async dropIndex(region: string, bucketName: string): Promise<void> {
    await this.#client.send(
      new DeleteIndexCommand({
        vectorBucketName: this.#vectorBucketName,
        indexName: this.#indexName(region, bucketName),
      }),
    );
  }

  /**
   * Compose the region-qualified S3 Vectors index name. Bucket names are unique
   * per region but not globally, so the region is prefixed to keep same-named
   * buckets in different regions on distinct indexes. The `:` separator avoids
   * ambiguity with the hyphens and dots that appear in both regions and bucket
   * names.
   */
  #indexName(region: string, bucketName: string): string {
    return `${region}:${bucketName}`;
  }
}

/**
 * Recover the `objectKey` portion of a `${objectKey}#${chunkIndex}` vector key.
 * Object keys may themselves contain `#`, so we split on the final separator.
 */
function objectKeyFromChunkKey(key: string): string {
  const lastHash = key.lastIndexOf('#');
  return lastHash === -1 ? key : key.slice(0, lastHash);
}
