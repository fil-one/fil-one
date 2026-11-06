import { z } from 'zod';

import { S3Region, type S3RegionLike } from '../constants.ts';

/**
 * Bucket Intelligence on a Forge appliance.
 *
 * In Forge regions, Bucket Intelligence runs in an engine container on the
 * Forge appliance instead of the Lambda + S3 Vectors pipeline used elsewhere.
 * The engine keeps each bucket's index as a Lance dataset in a companion bucket
 * on the tenant's own Forge storage, embeds with a model served next to it, and
 * answers through a configured model provider. The console backend calls it over
 * HTTPS with a shared bearer token and passes the tenant's Forge S3 credentials
 * on every request, so the engine holds no AWS credentials and no tenant state
 * beyond what is in the tenant's storage.
 *
 * This file is the wire contract between the console backend and the engine.
 */

/** Regions whose Bucket Intelligence runs on the Forge engine (non-production only). */
export const RAG_ENGINE_REGIONS: readonly S3Region[] = [S3Region.EuCentral3, S3Region.UsEast9];

/** Whether Bucket Intelligence for buckets in `region` runs on the Forge engine. */
export function usesRagEngine(region: S3RegionLike): boolean {
  return (RAG_ENGINE_REGIONS as readonly string[]).includes(region);
}

/**
 * Prefix of the companion buckets that hold Lance datasets. Reserved: users
 * cannot create buckets with it, and bucket listings hide it.
 */
export const RAG_COMPANION_BUCKET_PREFIX = 'filone-rag-';

/** How a query retrieves chunks from the Lance dataset. */
export type RagSearchMode = 'vector' | 'fulltext' | 'hybrid';

export const RAG_SEARCH_MODES: readonly RagSearchMode[] = ['vector', 'fulltext', 'hybrid'];

// ---------------------------------------------------------------------------
// Engine wire contract (console backend -> engine container)
// ---------------------------------------------------------------------------

/** Version prefix of every engine route (`/v1/...`). */
export const RAG_ENGINE_API_VERSION = 'v1';

/**
 * The bucket an engine request acts on, plus the tenant's credentials for the
 * Forge S3 gateway. The engine reads source objects from `bucketName` and keeps
 * the dataset in the companion bucket it derives from `(orgId, region, bucketName)`.
 */
export const RagEngineTargetSchema = z.object({
  orgId: z.string().min(1),
  region: z.string().min(1),
  bucketName: z.string().min(1),
  s3: z.object({
    endpointUrl: z.string().url(),
    region: z.string().min(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
  }),
});
export type RagEngineTarget = z.infer<typeof RagEngineTargetSchema>;

/** Body of `POST /v1/sync`, `/v1/status`, `/v1/versions` and `/v1/drop`. */
export const RagEngineTargetRequestSchema = z.object({ target: RagEngineTargetSchema });
export type RagEngineTargetRequest = z.infer<typeof RagEngineTargetRequestSchema>;

/** Body of `POST /v1/query`. */
export const RagEngineQueryRequestSchema = z.object({
  target: RagEngineTargetSchema,
  query: z.string().trim().min(1),
  topK: z.number().int().min(1).max(100).default(10),
  searchMode: z.enum(['vector', 'fulltext', 'hybrid']).default('vector'),
  /** Query the dataset as of this version (time travel). Absent = latest. */
  version: z.number().int().min(1).optional(),
  /** When false, retrieve only and skip answer generation. */
  answer: z.boolean().default(true),
});
export type RagEngineQueryRequest = z.infer<typeof RagEngineQueryRequestSchema>;

/** An index on the Lance dataset. */
export interface RagEngineIndexInfo {
  name: string;
  /** Lance index type as reported by the engine, e.g. `IVF_PQ`, `IVF_HNSW_SQ`, `FTS`. */
  type: string;
  columns: string[];
  /** Rows covered by the index; rows written since it was built are searched by flat scan. */
  indexedRows?: number;
  unindexedRows?: number;
}

/** What the Lance dataset looks like on the tenant's Forge storage. */
export interface RagEngineDatasetInfo {
  /** e.g. `s3://filone-rag-<hash>/lance/chunks.lance` */
  uri: string;
  /** The companion bucket holding the dataset. */
  companionBucket: string;
  table: string;
  version: number;
  rows: number;
  /** Distinct source objects with at least one chunk. */
  objects: number;
  /** Bytes the dataset occupies on Forge storage, when the engine can measure it. */
  storageBytes?: number;
  fragments?: number;
  indexes: RagEngineIndexInfo[];
  embedding: { model: string; dimension: number };
}

export type RagEngineSyncState = 'idle' | 'syncing' | 'error';

/** Response of `POST /v1/status` and `POST /v1/sync`. */
export interface RagEngineStatus {
  syncState: RagEngineSyncState;
  /** ISO-8601 time the last sync finished successfully. */
  lastSyncedAt?: string;
  lastSyncError?: string;
  /** Present while `syncState === 'syncing'`. */
  progress?: { objectsTotal: number; objectsDone: number; chunksWritten: number };
  /** Source objects currently indexed. */
  filesIndexed: number;
  /** Sum of the indexed source objects' sizes in bytes. */
  indexedBytes: number;
  /** Absent until the first sync creates the dataset. */
  dataset?: RagEngineDatasetInfo;
}

/** One version in the Lance dataset's history. */
export interface RagEngineVersion {
  version: number;
  /** ISO-8601 commit time. */
  timestamp: string;
  /** Lance tags pointing at this version. */
  tags?: string[];
}

/** Response of `POST /v1/versions`, newest first. */
export interface RagEngineVersionsResponse {
  versions: RagEngineVersion[];
}

/** A retrieved chunk, numbered as the answer cites it (`[n]`). */
export interface RagCitation {
  n: number;
  objectKey: string;
  chunkIndex: number;
  text: string;
  /** Relevance as reported by the search mode (distance for vector, BM25 for full text, RRF for hybrid). */
  score: number;
  scoreKind: 'distance' | 'bm25' | 'rrf';
}

/** How a query was served; shown in the console's retrieval trace. */
export interface RagQueryTrace {
  searchMode: RagSearchMode;
  /** The dataset version searched. */
  version: number;
  rows: number;
  /** Index used by the search, or `flat` when it scanned. */
  indexType: string;
  datasetUri: string;
  timings: { embedMs: number; searchMs: number; answerMs: number; totalMs: number };
  /** Bytes and requests read from Forge storage by the search, when the engine can measure them. */
  io?: { bytesRead: number; requests: number };
  models: { embedding: string; answer?: string };
}

/** Response of `POST /v1/query`. */
export interface RagEngineQueryResponse {
  /** Grounded answer citing chunks as `[n]`. Empty when `answer: false`. */
  answer: string;
  citations: RagCitation[];
  /** Deduplicated source object keys, in citation order. */
  sources: string[];
  trace: RagQueryTrace;
}

// ---------------------------------------------------------------------------
// Console API additions for engine-backed (Forge) buckets
// ---------------------------------------------------------------------------

/** Response of `GET /api/buckets/{name}/rag/engine?region=` (engine-backed buckets only). */
export interface BucketRagEngineResponse {
  status: RagEngineStatus;
  versions: RagEngineVersion[];
}
