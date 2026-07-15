import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { RAG_COMPANION_BUCKET_PREFIX } from '@filone/shared';

import { EMBEDDING_DIMENSION, MAX_METADATA_BYTES } from './constants.js';
import type { VectorQueryResult, VectorStoreChunk } from './schemas.js';
import type { EnsureIndexOptions, QueryOptions, VectorStore } from './vector-store.js';

/**
 * Blob format version. Bumped only on an incompatible on-disk layout change; it
 * doubles as the key prefix (`v1/…`) so a future format can coexist and old
 * blobs can be recognised and skipped.
 */
const FORMAT_VERSION = 1;

/** Key prefix (and `ListObjectsV2` scope) for all format-v1 object blobs. */
const BLOB_PREFIX = `v${FORMAT_VERSION}/`;

/**
 * Hard cap on chunks packed into a single object blob. At ~7 KB/chunk serialized
 * this bounds a blob at ~14 MB — comfortably within provider object limits and
 * one GET's memory. An object producing more chunks than this throws, which the
 * indexer's per-object failure isolation turns into a skipped object.
 */
const MAX_CHUNKS_PER_OBJECT = 2_000;

/** GET concurrency for a full-index scan (bounded so a large index cannot fan out unboundedly). */
const QUERY_CONCURRENCY = 16;

/** `DeleteObjects` batch size — the S3 multi-object-delete maximum. */
const DELETE_BATCH_SIZE = 1_000;

/** Concurrency for the single-delete fallback when a provider lacks multi-object delete. */
const DELETE_CONCURRENCY = 16;

/** Metadata key under which each chunk's source `objectKey` is stored (query filter + source attribution). */
const OBJECT_KEY_METADATA = 'objectKey';

/**
 * One chunk as persisted inside an object blob. `embedding` is a base64-encoded
 * little-endian `Float32Array`; `text` and `metadata` are stored verbatim.
 */
interface StoredChunk {
  key: string;
  text: string;
  metadata: Record<string, unknown>;
  embedding: string;
}

/** The JSON body of one `v1/<sha256(objectKey)>.json` blob: all of a source object's chunks. */
interface ObjectBlob {
  formatVersion: number;
  objectKey: string;
  dimension: number;
  chunks: StoredChunk[];
}

/**
 * Compose the companion index bucket name for a RAG-enabled bucket, isolated per
 * tenant. Mirrors {@link S3VectorsStore}'s index-name derivation (FIL-596): the
 * `(orgId, region, bucketName)` triple is joined on `#` — a delimiter that
 * cannot appear in any component (orgId is a UUID, region an enum, bucket names
 * are `[a-z0-9-]`) — and hashed so a bucket name reused across tenants never
 * resolves to another tenant's companion. 40 hex chars (160 bits) under the
 * fixed `filone-rag-` prefix is 51 chars total: within the 63-char cap and
 * always valid for `^[a-z0-9][a-z0-9-]*[a-z0-9]$`.
 */
export function companionBucketName(orgId: string, region: string, bucketName: string): string {
  const digest = createHash('sha256').update([orgId, region, bucketName].join('#')).digest('hex');
  return `${RAG_COMPANION_BUCKET_PREFIX}${digest.slice(0, 40)}`;
}

/**
 * Options for {@link BucketObjectVectorStore}.
 */
export interface BucketObjectVectorStoreOptions {
  /**
   * Idempotently ensure the companion bucket exists. The store cannot create
   * buckets itself — Aurora buckets only exist via the Portal API — so callers
   * inject provisioning (e.g. `orchestrator.createBucket` with
   * `BucketAlreadyExistsError` swallowed). Omit on read-only (query) paths.
   */
  ensureBucket?: (bucketName: string) => Promise<void>;
  /** Embedding dimensionality recorded in each blob. Defaults to {@link EMBEDDING_DIMENSION}. */
  dimension?: number;
}

/**
 * {@link VectorStore} backed by plain S3 objects in a per-RAG-bucket *companion*
 * bucket that lives on the SAME provider/region as the source bucket — so the
 * tenant's embeddings and chunk text never leave their own storage (no central
 * AWS S3 Vectors bucket).
 *
 * Layout (format v1): one JSON blob per source object at
 * `v1/<sha256(objectKey)>.json`, holding every chunk of that object (text,
 * metadata, and a base64 little-endian `Float32Array` embedding). The indexer
 * mutates chunks strictly per whole source object, which makes blob-per-object a
 * clean fit: upsert overwrites one blob, delete removes/rewrites one blob.
 *
 * Retrieval downloads the index and brute-forces similarity: Titan embeddings
 * are L2-normalised (see `embed`), so cosine similarity is the dot product and
 * the returned `score = 1 - dot` preserves the "lower = closer" contract of the
 * previous S3 Vectors store. This is fine within the query route's 30s timeout
 * up to a practical ceiling of ~20–40k chunks; a warm-container ETag-keyed cache
 * and a consolidated "index pack" are documented future optimisations.
 */
export class BucketObjectVectorStore implements VectorStore {
  readonly #client: S3Client;
  readonly #ensureBucket: ((bucketName: string) => Promise<void>) | undefined;
  readonly #dimension: number;

  constructor(client: S3Client, options: BucketObjectVectorStoreOptions = {}) {
    this.#client = client;
    this.#ensureBucket = options.ensureBucket;
    this.#dimension = options.dimension ?? EMBEDDING_DIMENSION;
  }

  /**
   * Ensure the companion bucket exists via the injected `ensureBucket` callback.
   * A no-op when no callback was supplied (e.g. the query path, which never
   * provisions). The distance metric and dimension in {@link EnsureIndexOptions}
   * are irrelevant here — companion buckets are plain object stores and
   * similarity is computed at query time — so they are ignored.
   */
  async ensureIndex(
    orgId: string,
    region: string,
    bucketName: string,
    _options?: EnsureIndexOptions,
  ): Promise<void> {
    if (!this.#ensureBucket) return;
    await this.#ensureBucket(companionBucketName(orgId, region, bucketName));
  }

  /**
   * Insert or overwrite chunks, one `PutObject` per source object (a full
   * overwrite of that object's blob — the companion has no versioning/lock, so
   * overwrite is update). Chunks are grouped by the `objectKey` recovered from
   * their `${objectKey}#${chunkIndex}` key.
   */
  async upsertChunks(
    orgId: string,
    region: string,
    bucketName: string,
    chunks: VectorStoreChunk[],
  ): Promise<void> {
    if (chunks.length === 0) return;
    const bucket = companionBucketName(orgId, region, bucketName);

    for (const [objectKey, group] of groupByObjectKey(chunks)) {
      if (group.length > MAX_CHUNKS_PER_OBJECT) {
        throw new Error(
          `Object "${objectKey}" produced ${group.length} chunks, ` +
            `exceeding the ${MAX_CHUNKS_PER_OBJECT} chunks-per-object limit`,
        );
      }
      const blob = this.#buildBlob(objectKey, group);
      await this.#client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: blobKey(objectKey),
          Body: JSON.stringify(blob),
          ContentType: 'application/json',
        }),
      );
    }
  }

  /**
   * Delete vectors by explicit key. Keys are grouped by source object; for each
   * object we GET its blob and either delete it (when every remaining chunk was
   * requested for deletion — the fast path) or rewrite it without the deleted
   * chunks. A missing blob (`NoSuchKey`) is treated as success (idempotent).
   */
  async deleteChunks(
    orgId: string,
    region: string,
    bucketName: string,
    keys: string[],
  ): Promise<void> {
    if (keys.length === 0) return;
    const bucket = companionBucketName(orgId, region, bucketName);

    for (const [objectKey, group] of groupKeysByObjectKey(keys)) {
      const blob = await this.#getBlob(bucket, blobKey(objectKey));
      if (!blob) continue; // NoSuchKey / unparseable — nothing to delete.

      const toDelete = new Set(group);
      const remaining = blob.chunks.filter((chunk) => !toDelete.has(chunk.key));
      if (remaining.length === 0) {
        await this.#client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: blobKey(objectKey) }),
        );
      } else if (remaining.length !== blob.chunks.length) {
        await this.#client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: blobKey(objectKey),
            Body: JSON.stringify({ ...blob, chunks: remaining }),
            ContentType: 'application/json',
          }),
        );
      }
    }
  }

  /**
   * k-NN search. With `filters.objectKey` this is a single GET of that object's
   * blob (no LIST); otherwise it paginates the index, GETs blobs with bounded
   * concurrency, and brute-forces similarity. Unparseable blobs are logged and
   * skipped; a missing companion bucket (`NoSuchBucket`) yields `[]`.
   */
  async query(
    orgId: string,
    region: string,
    bucketName: string,
    options: QueryOptions,
  ): Promise<VectorQueryResult[]> {
    const { embedding, k, filters } = options;
    if (k <= 0) return [];
    const bucket = companionBucketName(orgId, region, bucketName);
    const objectKey =
      typeof filters?.[OBJECT_KEY_METADATA] === 'string'
        ? (filters[OBJECT_KEY_METADATA] as string)
        : undefined;

    const heap = new TopKHeap(k);
    try {
      if (objectKey) {
        const blob = await this.#getBlob(bucket, blobKey(objectKey));
        if (blob) scoreBlobInto(blob, embedding, heap);
      } else {
        const keys = await this.#listBlobKeys(bucket);
        await mapWithConcurrency(keys, QUERY_CONCURRENCY, async (key) => {
          const blob = await this.#getBlob(bucket, key);
          if (blob) scoreBlobInto(blob, embedding, heap);
        });
      }
    } catch (error) {
      if (isNoSuchBucket(error)) return [];
      throw error;
    }

    return heap.toSortedAscending().map((scored) => ({
      key: scored.key,
      text: scored.text,
      metadata: scored.metadata,
      score: scored.score,
    }));
  }

  /**
   * Delete every object in the companion bucket (all format versions), paging
   * the listing and deleting in batches of {@link DELETE_BATCH_SIZE}. The bucket
   * itself is left in place (`deleteBucket` is unsupported on both providers). A
   * missing bucket (`NoSuchBucket`) is treated as success.
   */
  async dropIndex(orgId: string, region: string, bucketName: string): Promise<void> {
    const bucket = companionBucketName(orgId, region, bucketName);
    try {
      let continuationToken: string | undefined;
      do {
        const list = await this.#client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
          }),
        );
        const keys = (list.Contents ?? [])
          .map((object) => object.Key)
          .filter((key): key is string => typeof key === 'string');
        if (keys.length > 0) await this.#deleteObjects(bucket, keys);
        continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (error) {
      if (isNoSuchBucket(error)) return;
      throw error;
    }
  }

  /** Serialize one object's chunks into a blob, enforcing the 40KB per-chunk metadata parity check. */
  #buildBlob(objectKey: string, chunks: VectorStoreChunk[]): ObjectBlob {
    return {
      formatVersion: FORMAT_VERSION,
      objectKey,
      dimension: this.#dimension,
      chunks: chunks.map((chunk) => {
        if (!chunk.embedding) {
          throw new Error(`Chunk "${chunk.key}" is missing an embedding`);
        }
        const metadata: Record<string, unknown> = {
          ...chunk.metadata,
          [OBJECT_KEY_METADATA]: objectKey,
        };

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
          text: chunk.text,
          metadata,
          embedding: encodeEmbedding(chunk.embedding),
        };
      }),
    };
  }

  /**
   * GET and parse one blob. Returns `null` for a missing object (`NoSuchKey`) or
   * a corrupt/unparseable body (logged, then skipped so one bad blob never fails
   * a query). `NoSuchBucket` is rethrown so callers can map it to `[]`.
   */
  async #getBlob(bucket: string, key: string): Promise<ObjectBlob | null> {
    let body: string;
    try {
      const response = await this.#client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body) return null;
      body = await response.Body.transformToString('utf-8');
    } catch (error) {
      if (isNoSuchKey(error)) return null;
      throw error;
    }

    try {
      const parsed = JSON.parse(body) as ObjectBlob;
      if (!Array.isArray(parsed.chunks)) throw new Error('missing chunks array');
      return parsed;
    } catch (error) {
      console.warn('[bucket-object-vector-store] Skipping unparseable index blob', {
        bucket,
        key,
        error,
      });
      return null;
    }
  }

  /** Page the `v1/` listing and return every blob key. */
  async #listBlobKeys(bucket: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const list = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: BLOB_PREFIX,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const object of list.Contents ?? []) {
        if (typeof object.Key === 'string') keys.push(object.Key);
      }
      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }

  /**
   * Delete keys in batches via `DeleteObjects`, falling back to bounded parallel
   * single `DeleteObject`s if a provider lacks multi-object delete (support on
   * Aurora/FTH is unverified — see tests/s3compat).
   */
  async #deleteObjects(bucket: string, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
      try {
        await this.#client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      } catch (error) {
        if (!isMultiDeleteUnsupported(error)) throw error;
        await mapWithConcurrency(batch, DELETE_CONCURRENCY, (key) =>
          this.#client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
        );
      }
    }
  }
}

/** A scored candidate held during retrieval. */
interface ScoredChunk {
  key: string;
  text: string;
  metadata: Record<string, unknown>;
  score: number;
}

/**
 * Score every chunk in a blob against the query embedding and offer each to the
 * top-k heap. Titan embeddings are normalised, so cosine similarity is the dot
 * product and `score = 1 - dot` (lower = closer).
 */
function scoreBlobInto(blob: ObjectBlob, embedding: number[], heap: TopKHeap): void {
  for (const chunk of blob.chunks) {
    const vector = decodeEmbedding(chunk.embedding);
    const score = 1 - dot(vector, embedding);
    heap.offer({ key: chunk.key, text: chunk.text, metadata: chunk.metadata, score });
  }
}

/** Dot product over the shared prefix of the two vectors (all embeddings are the same fixed dimension). */
function dot(a: Float32Array, b: number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * Bounded max-heap keeping the k lowest-scoring (closest) candidates. Root is
 * the worst (largest score) kept item; a new item replaces the root only when it
 * is strictly better, so retrieval stays O(n·log k) in space O(k).
 */
class TopKHeap {
  readonly #k: number;
  readonly #heap: ScoredChunk[] = [];

  constructor(k: number) {
    this.#k = k;
  }

  offer(item: ScoredChunk): void {
    if (this.#k <= 0) return;
    if (this.#heap.length < this.#k) {
      this.#heap.push(item);
      this.#siftUp(this.#heap.length - 1);
    } else if (item.score < this.#heap[0]!.score) {
      this.#heap[0] = item;
      this.#siftDown(0);
    }
  }

  toSortedAscending(): ScoredChunk[] {
    return [...this.#heap].sort((a, b) => a.score - b.score);
  }

  #siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.#heap[i]!.score <= this.#heap[parent]!.score) break;
      this.#swap(i, parent);
      i = parent;
    }
  }

  #siftDown(index: number): void {
    const n = this.#heap.length;
    let i = index;
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let largest = i;
      if (left < n && this.#heap[left]!.score > this.#heap[largest]!.score) largest = left;
      if (right < n && this.#heap[right]!.score > this.#heap[largest]!.score) largest = right;
      if (largest === i) break;
      this.#swap(i, largest);
      i = largest;
    }
  }

  #swap(a: number, b: number): void {
    const tmp = this.#heap[a]!;
    this.#heap[a] = this.#heap[b]!;
    this.#heap[b] = tmp;
  }
}

/** Blob key for a source object: `v1/<sha256(objectKey)>.json`. */
function blobKey(objectKey: string): string {
  const digest = createHash('sha256').update(objectKey).digest('hex');
  return `${BLOB_PREFIX}${digest}.json`;
}

/** Group full chunks by the `objectKey` recovered from each chunk key. */
function groupByObjectKey(chunks: VectorStoreChunk[]): Map<string, VectorStoreChunk[]> {
  const byObject = new Map<string, VectorStoreChunk[]>();
  for (const chunk of chunks) {
    const objectKey = objectKeyFromChunkKey(chunk.key);
    const existing = byObject.get(objectKey);
    if (existing) existing.push(chunk);
    else byObject.set(objectKey, [chunk]);
  }
  return byObject;
}

/** Group vector keys by the `objectKey` recovered from each key. */
function groupKeysByObjectKey(keys: string[]): Map<string, string[]> {
  const byObject = new Map<string, string[]>();
  for (const key of keys) {
    const objectKey = objectKeyFromChunkKey(key);
    const existing = byObject.get(objectKey);
    if (existing) existing.push(key);
    else byObject.set(objectKey, [key]);
  }
  return byObject;
}

/**
 * Recover the `objectKey` portion of a `${objectKey}#${chunkIndex}` vector key.
 * Object keys may themselves contain `#`, so we split on the final separator
 * (mirrors {@link S3VectorsStore}).
 */
function objectKeyFromChunkKey(key: string): string {
  const lastHash = key.lastIndexOf('#');
  return lastHash === -1 ? key : key.slice(0, lastHash);
}

/** Encode an embedding as base64 of its little-endian `Float32Array` bytes. */
function encodeEmbedding(embedding: number[]): string {
  const buffer = Buffer.allocUnsafe(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buffer.writeFloatLE(embedding[i]!, i * 4);
  }
  return buffer.toString('base64');
}

/** Decode a base64 little-endian `Float32Array` embedding. */
function decodeEmbedding(encoded: string): Float32Array {
  const buffer = Buffer.from(encoded, 'base64');
  const out = new Float32Array(Math.floor(buffer.length / 4));
  for (let i = 0; i < out.length; i++) {
    out[i] = buffer.readFloatLE(i * 4);
  }
  return out;
}

/**
 * Run `task` over `items` with at most `limit` in flight, preserving no order.
 * Rejections propagate (the first failure rejects the whole run).
 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<unknown>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      await task(items[index]!);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
}

/** True for the S3 "no such key" error (a missing object). */
function isNoSuchKey(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  return name === 'NoSuchKey' || name === 'NotFound';
}

/** True for the S3 "no such bucket" error (a never-created / torn-down companion). */
function isNoSuchBucket(error: unknown): boolean {
  return (error as { name?: string }).name === 'NoSuchBucket';
}

/**
 * True when a provider rejected `DeleteObjects` because it lacks multi-object
 * delete (surfaces as 501 Not Implemented or 405 Method Not Allowed). Support on
 * Aurora/FTH is unverified, so this drives the single-delete fallback.
 */
function isMultiDeleteUnsupported(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return (
    name === 'NotImplemented' || name === 'MethodNotAllowed' || status === 501 || status === 405
  );
}
