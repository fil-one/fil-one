import { createHash } from 'node:crypto';
import {
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
import type { EnsureIndexOptions, QueryOptions, VectorStore } from './vector-store.js';

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
 * RAG-enabled bucket. Bucket names are globally namespaced and can be reused
 * across tenants, so each index is named from the `(orgId, region, bucketName)`
 * triple (see {@link #indexName}) — this is what keeps a reused bucket name from
 * resolving to another tenant's index (FIL-596).
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
    orgId: string,
    region: string,
    bucketName: string,
    options?: EnsureIndexOptions,
  ): Promise<void> {
    const dimension = options?.dimension ?? EMBEDDING_DIMENSION;
    try {
      await this.#client.send(
        new CreateIndexCommand({
          vectorBucketName: this.#vectorBucketName,
          indexName: this.#indexName(orgId, region, bucketName),
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
    } catch (error: unknown) {
      // Idempotent: an existing index surfaces as a ConflictException, which we
      // treat as success. Under org-scoped index names a conflict for a
      // genuinely new bucket should not happen, but a same-org delete+recreate
      // of a bucket name can still hit its own leftover index until RAG teardown
      // ships (FIL-596 follow-up). So we surface it for triage rather than
      // failing the run; escalating to a hard error is deferred to that PR.
      if ((error as { name?: string }).name === 'ConflictException') {
        console.warn('[s3-vectors-store] ensureIndex hit existing index (ConflictException)', {
          orgId,
          region,
          bucketName,
        });
        return;
      }
      throw error;
    }
  }

  async upsertChunks(
    orgId: string,
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
        indexName: this.#indexName(orgId, region, bucketName),
        vectors,
      }),
    );
  }

  async deleteChunks(
    orgId: string,
    region: string,
    bucketName: string,
    keys: string[],
  ): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    await this.#client.send(
      new DeleteVectorsCommand({
        vectorBucketName: this.#vectorBucketName,
        indexName: this.#indexName(orgId, region, bucketName),
        keys,
      }),
    );
  }

  async query(
    orgId: string,
    region: string,
    bucketName: string,
    options: QueryOptions,
  ): Promise<VectorQueryResult[]> {
    const { embedding, k, filters } = options;
    const response = await this.#client.send(
      new QueryVectorsCommand({
        vectorBucketName: this.#vectorBucketName,
        indexName: this.#indexName(orgId, region, bucketName),
        topK: k,
        queryVector: { float32: embedding },
        returnMetadata: true,
        returnDistance: true,
        ...(filters ? { filter: filters as DocumentType } : {}),
      }),
    );

    return (response.vectors ?? [])
      .map((vector) => {
        if (!vector.key || typeof vector.distance !== 'number') {
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

  async dropIndex(orgId: string, region: string, bucketName: string): Promise<void> {
    await this.#client.send(
      new DeleteIndexCommand({
        vectorBucketName: this.#vectorBucketName,
        indexName: this.#indexName(orgId, region, bucketName),
      }),
    );
  }

  /**
   * Compose the S3 Vectors index name for a bucket's vectors, isolated per
   * tenant. `orgId` is part of the identity so a bucket name reused across
   * tenants never collides on one index (FIL-596).
   *
   * S3 Vectors index names are constrained to 3-63 chars from [a-z0-9-.], must
   * begin and end with an alphanumeric, and must be unique within the vector
   * bucket. The raw orgId:region:bucketName triple satisfies none of that (the
   * colon is invalid and a 36-char UUID plus a 63-char bucket name blows the
   * length cap), so we hash the triple into a fixed-width, charset-safe name.
   * The parts are joined on ':', a character that cannot appear in any component
   * (orgId is a UUID, region an enum, bucket names are [a-z0-9-]), so the mapping
   * is unambiguous; it lives inside the hashed input, not the final name, so the
   * name's charset constraints do not apply to it. SHA-256 makes it
   * deterministic and collision-resistant; 56 hex chars (224 bits) under a fixed
   * `rag-` prefix is 60 chars total — within the cap and always valid.
   */
  #indexName(orgId: string, region: string, bucketName: string): string {
    const digest = createHash('sha256').update([orgId, region, bucketName].join(':')).digest('hex');
    return `rag-${digest.slice(0, 56)}`;
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
