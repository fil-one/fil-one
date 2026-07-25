import { Field, FixedSizeList, Float32, Schema, Utf8 } from 'apache-arrow';
import * as lancedb from '@lancedb/lancedb';
import { EMBEDDING_DIMENSION, MAX_METADATA_BYTES } from './constants.js';
import type { VectorQueryResult, VectorStoreChunk } from './schemas.js';
import type { EnsureIndexOptions, QueryOptions, VectorStore } from './vector-store.js';
import { companionBucketName } from './bucket-object-vector-store.js';

/**
 * SPIKE — an alternative to {@link BucketObjectVectorStore} that keeps the same
 * companion-bucket architecture but stores the index as a Lance dataset instead
 * of hand-rolled JSON blobs, so the ANN structure is a dependency rather than
 * something we maintain.
 *
 * Same placement, same trust boundary: the dataset lives at
 * `s3://<companion bucket>/<DATASET_ROOT>` on the tenant's own provider and
 * region. What changes is the read path — Lance range-reads only the IVF-PQ
 * partitions a query probes, instead of downloading every chunk.
 *
 * Measured head-to-head over 10k chunks against the same S3 server
 * (`spike/lance-probe.test.ts`): 65.6 MB and 501 requests per query for the
 * JSON-blob brute force, 2.2 MB and 101 requests here.
 *
 * PROVIDER REQUIREMENT — the S3 surface is GET (incl. Range), PUT,
 * ListObjectsV2, DeleteObjects and multipart upload, plus **one conditional PUT
 * (`If-None-Match: *`) per commit**, used to write the dataset manifest. Reads
 * need no conditional support at all, so the query path runs anywhere; it is the
 * indexer that requires it. Whether Aurora and FTH honour `If-None-Match` is the
 * open question this spike cannot answer without a stage — see
 * `docs/architectural-decisions/rag-vector-store-options.md`.
 */
export class LanceVectorStore implements VectorStore {
  readonly #storage: LanceStorageContext;
  readonly #ensureBucket: ((bucketName: string) => Promise<void>) | undefined;
  readonly #dimension: number;
  readonly #indexThreshold: number;

  constructor(storage: LanceStorageContext, options: LanceVectorStoreOptions = {}) {
    this.#storage = storage;
    this.#ensureBucket = options.ensureBucket;
    this.#dimension = options.dimension ?? EMBEDDING_DIMENSION;
    this.#indexThreshold = options.indexThreshold ?? DEFAULT_INDEX_THRESHOLD;
  }

  async ensureIndex(
    orgId: string,
    region: string,
    bucketName: string,
    options: EnsureIndexOptions = {},
  ): Promise<void> {
    if (options.dimension !== undefined && options.dimension !== this.#dimension) {
      throw new Error(
        `Index dimension is fixed at ${this.#dimension}, cannot create with ${options.dimension}`,
      );
    }
    if (options.distance !== undefined && options.distance !== 'cosine') {
      throw new Error(`Only cosine distance is supported, got "${String(options.distance)}"`);
    }

    const bucket = companionBucketName(orgId, region, bucketName);
    await this.#ensureBucket?.(bucket);

    const db = await this.#connect(bucket);
    const names = await db.tableNames();
    if (names.includes(TABLE_NAME)) return;
    await db.createEmptyTable(TABLE_NAME, arrowSchema(this.#dimension), { mode: 'create' });
  }

  /**
   * Insert or overwrite by `key`. Lance's merge-insert is a single atomic commit
   * per call, which makes this idempotent without the read-modify-write cycle
   * the JSON-blob layout needs — and therefore without that layout's reliance on
   * the caller serialising work per bucket.
   */
  async upsertChunks(
    orgId: string,
    region: string,
    bucketName: string,
    chunks: VectorStoreChunk[],
  ): Promise<void> {
    if (chunks.length === 0) return;

    const rows = chunks.map((chunk) => {
      if (!chunk.embedding) {
        throw new Error(`Chunk "${chunk.key}" has no embedding`);
      }
      if (chunk.embedding.length !== this.#dimension) {
        throw new Error(
          `Chunk "${chunk.key}" embedding has ${chunk.embedding.length} dimensions, expected ${this.#dimension}`,
        );
      }
      // Parity with BucketObjectVectorStore: metadata is capped so an index
      // built by either store stays portable to the other.
      const metadata = JSON.stringify(chunk.metadata ?? {});
      const metadataBytes = Buffer.byteLength(metadata, 'utf8');
      if (metadataBytes > MAX_METADATA_BYTES) {
        throw new Error(
          `Chunk "${chunk.key}" metadata is ${metadataBytes} bytes, exceeding the ${MAX_METADATA_BYTES} byte limit`,
        );
      }
      return {
        key: chunk.key,
        objectKey: objectKeyFromChunkKey(chunk.key),
        text: chunk.text,
        metadata,
        vector: chunk.embedding,
      };
    });

    const table = await this.#openTable(orgId, region, bucketName);
    await table.mergeInsert('key').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);

    await this.#maybeCreateIndex(table);
  }

  async deleteChunks(
    orgId: string,
    region: string,
    bucketName: string,
    keys: string[],
  ): Promise<void> {
    if (keys.length === 0) return;
    const table = await this.#openTable(orgId, region, bucketName);
    await table.delete(`key IN (${keys.map(sqlQuote).join(', ')})`);
  }

  async query(
    orgId: string,
    region: string,
    bucketName: string,
    options: QueryOptions,
  ): Promise<VectorQueryResult[]> {
    const { embedding, k, filters } = options;
    if (k <= 0) return [];

    let table: lancedb.Table;
    try {
      table = await this.#openTable(orgId, region, bucketName);
    } catch (error) {
      // A bucket that has never been indexed has no companion bucket and no
      // dataset; both surface as "not found" and mean "no relevant content".
      if (isNotFound(error)) return [];
      throw error;
    }

    const objectKey = typeof filters?.objectKey === 'string' ? filters.objectKey : undefined;
    // `query().nearestTo()` rather than `search()`: the latter also accepts a
    // full-text query, so it returns a union that has no `distanceType`.
    let search = table.query().nearestTo(embedding).distanceType('cosine').limit(k);
    if (objectKey) {
      // `where` pre-filters by default, so `k` counts matching rows rather than
      // rows surviving a post-filter (`postfilter()` opts out).
      search = search.where(`objectKey = ${sqlQuote(objectKey)}`);
    }

    const rows = (await search.toArray()) as LanceRow[];
    return rows.map((row) => ({
      key: String(row.key),
      text: String(row.text),
      metadata: parseMetadata(row.metadata),
      // Lance's cosine `_distance` is 1 - cosine similarity, matching the
      // `1 - dot` convention in BucketObjectVectorStore (lower = closer).
      score: Number(row._distance),
    }));
  }

  /**
   * Drop the dataset and everything under it. The companion bucket itself is
   * left in place, matching {@link BucketObjectVectorStore.dropIndex} — neither
   * provider supports DeleteBucket.
   */
  async dropIndex(orgId: string, region: string, bucketName: string): Promise<void> {
    const bucket = companionBucketName(orgId, region, bucketName);
    try {
      const db = await this.#connect(bucket);
      await db.dropTable(TABLE_NAME);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async #connect(bucket: string): Promise<lancedb.Connection> {
    return lancedb.connect(`s3://${bucket}/${DATASET_ROOT}`, {
      storageOptions: toStorageOptions(this.#storage),
    });
  }

  async #openTable(orgId: string, region: string, bucketName: string): Promise<lancedb.Table> {
    const bucket = companionBucketName(orgId, region, bucketName);
    const db = await this.#connect(bucket);
    const names = await db.tableNames();
    if (!names.includes(TABLE_NAME)) {
      await this.#ensureBucket?.(bucket);
      return db.createEmptyTable(TABLE_NAME, arrowSchema(this.#dimension), {
        mode: 'create',
        existOk: true,
      });
    }
    return db.openTable(TABLE_NAME);
  }

  /**
   * Build the ANN index once the dataset is large enough to benefit. Below the
   * threshold Lance falls back to a flat scan, which is both faster and more
   * accurate than a poorly-trained IVF index — and training needs meaningfully
   * more rows than partitions to produce usable centroids.
   */
  async #maybeCreateIndex(table: lancedb.Table): Promise<void> {
    const rows = await table.countRows();
    if (rows < this.#indexThreshold) return;
    const existing = await table.listIndices();
    if (existing.some((index) => index.columns.includes(VECTOR_COLUMN))) return;

    await table.createIndex(VECTOR_COLUMN, {
      config: lancedb.Index.ivfPq({
        // √n partitions is the usual starting point; capped so a very large
        // bucket does not produce an unreasonable number of probes.
        numPartitions: Math.min(MAX_PARTITIONS, Math.max(1, Math.round(Math.sqrt(rows)))),
        numSubVectors: SUB_VECTORS,
        distanceType: 'cosine',
      }),
    });
  }
}

/** Connection details for the tenant's S3-compatible provider. */
export interface LanceStorageContext {
  endpointUrl: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** Aurora and FTH are both path-style. Defaults to `true`. */
  forcePathStyle?: boolean;
}

export interface LanceVectorStoreOptions {
  /**
   * Provision the companion bucket. Aurora buckets exist only through the
   * Portal API, so the store cannot create one itself.
   */
  ensureBucket?: (bucketName: string) => Promise<void>;
  /** Vector dimensionality. Defaults to {@link EMBEDDING_DIMENSION}. */
  dimension?: number;
  /** Row count below which no ANN index is built. */
  indexThreshold?: number;
}

/** One row as Lance returns it; `_distance` is added by a vector search. */
interface LanceRow {
  key: unknown;
  text: unknown;
  metadata: unknown;
  _distance: unknown;
}

/** Dataset location within the companion bucket. */
const DATASET_ROOT = 'lance';
const TABLE_NAME = 'chunks';
const VECTOR_COLUMN = 'vector';

/**
 * Below this many rows a flat scan beats a trained index. 10k × ~5 KB is ~50 MB,
 * which is the point at which the full download stops being acceptable.
 */
const DEFAULT_INDEX_THRESHOLD = 10_000;
const MAX_PARTITIONS = 512;
/** 1024 dims / 64 sub-vectors = 16 dims each, the usual PQ working point. */
const SUB_VECTORS = 64;

function arrowSchema(dimension: number): Schema {
  return new Schema([
    new Field('key', new Utf8(), false),
    new Field('objectKey', new Utf8(), false),
    new Field('text', new Utf8(), false),
    new Field('metadata', new Utf8(), false),
    new Field(
      VECTOR_COLUMN,
      new FixedSizeList(dimension, new Field('item', new Float32(), true)),
      false,
    ),
  ]);
}

/** Vector keys are `${objectKey}#${chunkIndex}`; everything before the last `#`. */
function objectKeyFromChunkKey(key: string): string {
  const hash = key.lastIndexOf('#');
  return hash === -1 ? key : key.slice(0, hash);
}

/** Single-quote a string for a Lance/DataFusion SQL predicate. */
function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toStorageOptions(storage: LanceStorageContext): Record<string, string> {
  const options: Record<string, string> = {
    endpoint: storage.endpointUrl,
    region: storage.region,
    accessKeyId: storage.credentials.accessKeyId,
    secretAccessKey: storage.credentials.secretAccessKey,
    virtualHostedStyleRequest: String(storage.forcePathStyle === false),
  };
  if (storage.credentials.sessionToken) options.sessionToken = storage.credentials.sessionToken;
  if (storage.endpointUrl.startsWith('http://')) options.allowHttp = 'true';
  return options;
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    error.name === 'NoSuchBucket' ||
    error.name === 'NotFound' ||
    message.includes('was not found') ||
    message.includes('does not exist') ||
    message.includes('no such bucket')
  );
}
