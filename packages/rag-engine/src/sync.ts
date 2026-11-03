import type { S3Client } from '@aws-sdk/client-s3';
import type * as lancedb from '@lancedb/lancedb';
import { chunk, extractText } from '@filone/rag-shared';
import type { RagEngineSyncState, RagEngineTarget } from '@filone/shared';

import { resolveContentType } from './content-type.ts';
import { readEngineState, writeEngineState, type EngineState } from './engine-state.ts';
import type { EngineContext } from './engine-context.ts';
import {
  connectDataset,
  deleteObjectRows,
  finalizeDataset,
  readIndexedObjects,
  writeChunks,
  type ChunkRow,
  type IndexedObject,
} from './lance-store.ts';
import {
  TABLE_NAME,
  companionBucketName,
  createS3Client,
  ensureBucket,
  getObject,
  listSourceObjects,
  storageFor,
  type SourceObject,
  type StorageContext,
} from './storage.ts';

/** Objects replaced per commit; matches the predicate size `writeChunks` accepts. */
const MAX_REPLACED_PER_COMMIT = 200;

export interface SyncProgress {
  objectsTotal: number;
  objectsDone: number;
  chunksWritten: number;
}

/** What the engine remembers about one target between requests. */
export interface TargetSyncState {
  syncState: RagEngineSyncState;
  lastSyncedAt?: string;
  lastSyncError?: string;
  progress?: SyncProgress;
  running?: Promise<void>;
  cancelled: boolean;
}

export interface SyncPlan {
  toIndex: SourceObject[];
  removed: string[];
}

/**
 * Compare the source listing with the dataset. New and changed objects are
 * indexed; objects gone from the source are removed. Objects with no
 * extractable type, too large, or already tried at this ETag are left out.
 */
export function planSync(
  source: SourceObject[],
  indexed: Map<string, IndexedObject>,
  skipped: Record<string, string>,
  maxObjectBytes: number,
): SyncPlan {
  const toIndex: SourceObject[] = [];
  const present = new Set<string>();
  for (const object of source) {
    present.add(object.key);
    if (!resolveContentType(object.key) || object.size > maxObjectBytes) continue;
    if (skipped[object.key] === object.etag) continue;
    if (indexed.get(object.key)?.etag === object.etag) continue;
    toIndex.push(object);
  }
  const removed = [...indexed.keys()].filter((key) => !present.has(key));
  // Indexed objects that are no longer indexable (now too large, say) go too.
  for (const object of source) {
    if (indexed.has(object.key) && object.size > maxObjectBytes) removed.push(object.key);
  }
  return { toIndex, removed };
}

/** Buffers chunks and commits them in batches of about `flushRows`. */
class BatchWriter {
  table: lancedb.Table | undefined;
  readonly #db: lancedb.Connection;
  readonly #flushRows: number;
  readonly #progress: SyncProgress;
  #rows: ChunkRow[] = [];
  #replace: string[] = [];

  constructor(
    db: lancedb.Connection,
    table: lancedb.Table | undefined,
    flushRows: number,
    progress: SyncProgress,
  ) {
    this.#db = db;
    this.table = table;
    this.#flushRows = flushRows;
    this.#progress = progress;
  }

  async add(rows: ChunkRow[], replaces: boolean, objectKey: string): Promise<void> {
    this.#rows.push(...rows);
    if (replaces) this.#replace.push(objectKey);
    if (this.#rows.length >= this.#flushRows || this.#replace.length >= MAX_REPLACED_PER_COMMIT) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.#rows.length === 0) return;
    this.table = await writeChunks(this.#db, this.table, this.#rows, this.#replace);
    this.#progress.chunksWritten += this.#rows.length;
    this.#rows = [];
    this.#replace = [];
  }
}

interface SyncRun {
  ctx: EngineContext;
  target: RagEngineTarget;
  companion: string;
  storage: StorageContext;
  s3: S3Client;
  state: TargetSyncState;
}

/** Fetch, extract and chunk one object. Undefined when it yields no text. */
async function chunkObject(run: SyncRun, object: SourceObject): Promise<string[] | undefined> {
  const { bytes, contentType } = await getObject(run.s3, run.target.bucketName, object.key);
  const type = resolveContentType(object.key, contentType);
  if (!type) return undefined;
  try {
    const text = await extractText(bytes, type);
    const chunks = chunk(text);
    return chunks.length > 0 ? chunks : undefined;
  } catch (error) {
    run.ctx.log('warn', 'extract_failed', {
      bucket: run.target.bucketName,
      objectKey: object.key,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function toRows(object: SourceObject, chunks: string[], vectors: number[][]): ChunkRow[] {
  return chunks.map((text, chunkIndex) => ({
    objectKey: object.key,
    etag: object.etag,
    objectSize: BigInt(object.size),
    chunkIndex,
    text,
    vector: vectors[chunkIndex] ?? [],
  }));
}

/** Open the table, dropping it first if it was built with another embedding model. */
async function openForSync(
  run: SyncRun,
  db: lancedb.Connection,
  engineState: EngineState,
): Promise<lancedb.Table | undefined> {
  if (!(await db.tableNames()).includes(TABLE_NAME)) return undefined;
  const model = engineState.embedding?.model;
  if (model && model !== run.ctx.embedder.model) {
    run.ctx.log('info', 'embedding_model_changed', { from: model, to: run.ctx.embedder.model });
    await db.dropTable(TABLE_NAME);
    engineState.skipped = {};
    return undefined;
  }
  return db.openTable(TABLE_NAME);
}

interface IndexWork {
  plan: SyncPlan;
  writer: BatchWriter;
  indexed: Map<string, IndexedObject>;
  engineState: EngineState;
}

/** Index every planned object. Returns the embedding width seen, if any. */
async function indexObjects(run: SyncRun, work: IndexWork): Promise<number | undefined> {
  const { plan, writer, indexed, engineState } = work;
  const progress = run.state.progress!;
  let dimension: number | undefined;
  for (const object of plan.toIndex) {
    if (run.state.cancelled) throw new Error('Sync cancelled');
    const chunks = await chunkObject(run, object);
    if (!chunks) {
      engineState.skipped[object.key] = object.etag;
      if (indexed.has(object.key)) plan.removed.push(object.key);
    } else {
      delete engineState.skipped[object.key];
      const vectors = await run.ctx.embedder.embed(chunks);
      dimension = vectors[0]?.length ?? dimension;
      await writer.add(toRows(object, chunks, vectors), indexed.has(object.key), object.key);
    }
    progress.objectsDone += 1;
  }
  await writer.flush();
  return dimension;
}

async function reconcile(run: SyncRun): Promise<void> {
  const { ctx, s3, companion } = run;
  await ensureBucket(s3, companion);
  const engineState = await readEngineState(s3, companion);
  const db = await connectDataset(run.storage, companion);
  const table = await openForSync(run, db, engineState);
  const indexed = table ? await readIndexedObjects(table) : new Map<string, IndexedObject>();
  const source = await listSourceObjects(s3, run.target.bucketName);
  const plan = planSync(source, indexed, engineState.skipped, ctx.config.maxObjectBytes);
  run.state.progress = { objectsTotal: plan.toIndex.length, objectsDone: 0, chunksWritten: 0 };

  const writer = new BatchWriter(db, table, ctx.config.flushRows, run.state.progress);
  const dimension = await indexObjects(run, { plan, writer, indexed, engineState });
  if (writer.table && plan.removed.length > 0) await deleteObjectRows(writer.table, plan.removed);
  if (writer.table && (plan.toIndex.length > 0 || plan.removed.length > 0)) {
    await finalizeDataset(writer.table, { vectorIndexMinRows: ctx.config.vectorIndexMinRows });
  }

  const present = new Set(source.map((object) => object.key));
  for (const key of Object.keys(engineState.skipped)) {
    if (!present.has(key)) delete engineState.skipped[key];
  }
  engineState.lastSyncedAt = new Date().toISOString();
  if (dimension) engineState.embedding = { model: ctx.embedder.model, dimension };
  await writeEngineState(s3, companion, engineState);
  run.state.lastSyncedAt = engineState.lastSyncedAt;
  ctx.log('info', 'sync_done', {
    bucket: run.target.bucketName,
    indexed: plan.toIndex.length,
    removed: plan.removed.length,
    chunks: run.state.progress.chunksWritten,
  });
}

/**
 * Runs at most one sync per target. Sync state lives in memory: the engine is
 * one container, and the dataset itself is the durable record.
 */
export class SyncManager {
  readonly #ctx: EngineContext;
  readonly #states = new Map<string, TargetSyncState>();

  constructor(ctx: EngineContext) {
    this.#ctx = ctx;
  }

  get(companion: string): TargetSyncState | undefined {
    return this.#states.get(companion);
  }

  /** Start a sync for `target` unless one is already running. */
  start(target: RagEngineTarget): TargetSyncState {
    const companion = companionBucketName(target.orgId, target.region, target.bucketName);
    const existing = this.#states.get(companion);
    if (existing?.running) return existing;

    const state: TargetSyncState = {
      syncState: 'syncing',
      lastSyncedAt: existing?.lastSyncedAt,
      cancelled: false,
      progress: { objectsTotal: 0, objectsDone: 0, chunksWritten: 0 },
    };
    const storage = storageFor(target, this.#ctx.config.s3EndpointOverride);
    const run: SyncRun = {
      ctx: this.#ctx,
      target,
      companion,
      storage,
      s3: createS3Client(storage),
      state,
    };
    state.running = reconcile(run)
      .then(() => {
        state.syncState = 'idle';
        state.lastSyncError = undefined;
      })
      .catch((error: unknown) => {
        state.syncState = 'error';
        state.lastSyncError = error instanceof Error ? error.message : String(error);
        this.#ctx.log('error', 'sync_failed', {
          bucket: target.bucketName,
          error: state.lastSyncError,
        });
      })
      .finally(() => {
        state.running = undefined;
        state.progress = undefined;
        run.s3.destroy();
      });
    this.#states.set(companion, state);
    return state;
  }

  /** Stop any running sync for the companion bucket and forget its state. */
  async cancel(companion: string): Promise<void> {
    const state = this.#states.get(companion);
    if (state?.running) {
      state.cancelled = true;
      await state.running;
    }
    this.#states.delete(companion);
  }

  /** Wait for every running sync (tests and shutdown). */
  async idle(): Promise<void> {
    const running = [...this.#states.values()].flatMap((state) =>
      state.running ? [state.running] : [],
    );
    await Promise.all(running);
  }
}
