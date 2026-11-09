import type { S3Client } from '@aws-sdk/client-s3';
import type * as lancedb from '@lancedb/lancedb';
import { chunk, extractText } from '@filone/rag-shared';
import type { RagEngineSyncState, RagEngineTarget } from '@filone/shared';

import { resolveContentType } from './content-type.ts';
import { readEngineState, writeEngineState, type EngineState } from './engine-state.ts';
import type { EngineContext } from './engine-context.ts';
import { EngineError, errorLogFields, summarizeError } from './errors.ts';
import {
  connectDataset,
  deleteObjectRows,
  finalizeDataset,
  hasUnindexedRows,
  missingIndexes,
  openCommittedTable,
  readIndexedObjects,
  schemaDimension,
  tagSyncVersion,
  writeChunks,
  type ChunkRow,
  type IndexedObject,
} from './lance-store.ts';
import {
  TABLE_NAME,
  bucketExists,
  companionBucketName,
  createS3Client,
  ensureBucket,
  getObject,
  isNoSuchBucket,
  isNoSuchKey,
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

/**
 * Fetch, extract and chunk one object. Undefined when it yields no text;
 * `'gone'` when it was deleted after the listing.
 */
async function chunkObject(
  run: SyncRun,
  object: SourceObject,
): Promise<string[] | undefined | 'gone'> {
  let fetched: Awaited<ReturnType<typeof getObject>>;
  try {
    fetched = await getObject(run.s3, run.target.bucketName, object.key);
  } catch (error) {
    if (isNoSuchKey(error)) return 'gone';
    throw error;
  }
  const { bytes, contentType } = fetched;
  const type = resolveContentType(object.key, contentType);
  if (!type) return undefined;
  try {
    const text = await extractText(bytes, type);
    const chunks = chunk(text);
    const max = run.ctx.config.maxChunksPerObject;
    if (chunks.length > max) {
      run.ctx.log('warn', 'object_truncated', {
        bucket: run.target.bucketName,
        objectKey: object.key,
        chunks: chunks.length,
        indexedChunks: max,
      });
      return chunks.slice(0, max);
    }
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

/** Table names in the dataset; none while the companion bucket does not exist. */
async function tableNames(db: lancedb.Connection): Promise<string[]> {
  try {
    return await db.tableNames();
  } catch (error) {
    if (isNoSuchBucket(error)) return [];
    throw error;
  }
}

/** Open the table, dropping it first if it was built with another embedding model. */
async function openForSync(
  run: SyncRun,
  db: lancedb.Connection,
  engineState: EngineState,
): Promise<lancedb.Table | undefined> {
  if (!(await tableNames(db)).includes(TABLE_NAME)) return undefined;
  const model = engineState.embedding?.model;
  if (model && model !== run.ctx.embedder.model) {
    run.ctx.log('info', 'embedding_model_changed', {
      from: model,
      to: run.ctx.embedder.model,
    });
    await db.dropTable(TABLE_NAME);
    engineState.skipped = {};
    return undefined;
  }
  return openCommittedTable(db);
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
    if (chunks === 'gone') {
      if (indexed.has(object.key)) plan.removed.push(object.key);
    } else if (!chunks) {
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

/** How often a sync with nothing to do still records `lastSyncedAt` in the bucket. */
const STATE_REFRESH_MS = 60 * 60 * 1000;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The parts of the engine state whose change must be written back. */
const durableState = (state: EngineState): string =>
  JSON.stringify({ skipped: state.skipped, embedding: state.embedding });

interface Dataset {
  engineState: EngineState;
  /** `durableState` as read, to tell whether the sync changed it. */
  stateBefore: string;
  /** Undefined until the companion bucket exists. */
  db?: lancedb.Connection;
  table?: lancedb.Table;
}

/**
 * Read the engine state and open the dataset. Before the first sync with work
 * there is no companion bucket; checking first keeps Lance from retrying a
 * listing of a bucket that is not there.
 */
async function loadDataset(run: SyncRun): Promise<Dataset> {
  if (!(await bucketExists(run.s3, run.companion))) {
    const engineState: EngineState = { skipped: {} };
    return { engineState, stateBefore: durableState(engineState) };
  }
  const engineState = await readEngineState(run.s3, run.companion);
  const stateBefore = durableState(engineState);
  const db = await connectDataset(run.storage, run.companion);
  const table = await openForSync(run, db, engineState);
  return { engineState, stateBefore, db, table };
}

/**
 * Build missing indexes, compact, and tag the finished version. A sync with no
 * changes still does this when an index is missing or leaves rows out: an
 * earlier sync stopped between its data commits and its index commits.
 */
async function finishDataset(run: SyncRun, table: lancedb.Table, changed: boolean, at: Date) {
  const options = { vectorIndexMinRows: run.ctx.config.vectorIndexMinRows };
  if (!changed) {
    const missing = await missingIndexes(table, options);
    if (!missing.text && !missing.vector && !(await hasUnindexedRows(table))) return;
  }
  await finalizeDataset(table, options);
  try {
    await tagSyncVersion(table, at);
  } catch (error) {
    // The tag only marks the version for the history view; the sync stands.
    run.ctx.log('warn', 'tag_failed', { bucket: run.target.bucketName, error: errorText(error) });
  }
}

/**
 * Write the engine state when the sync changed it, or hourly to refresh
 * `lastSyncedAt`; a sync of an unchanged bucket otherwise writes nothing.
 */
async function saveState(run: SyncRun, dataset: Dataset, changed: boolean, at: Date) {
  const { engineState } = dataset;
  const previous = engineState.lastSyncedAt ? Date.parse(engineState.lastSyncedAt) : 0;
  const stale = at.getTime() - previous >= STATE_REFRESH_MS;
  engineState.lastSyncedAt = at.toISOString();
  run.state.lastSyncedAt = engineState.lastSyncedAt;
  const stateChanged = changed || durableState(engineState) !== dataset.stateBefore;
  if (stateChanged || (stale && dataset.table)) {
    await writeEngineState(run.s3, run.companion, engineState);
  }
}

/**
 * Record the embedding model the dataset was built with. A sync that finished
 * the dataset but failed to write its state leaves no record; the retry
 * embeds nothing, and since the dataset is current, the model is this one.
 */
async function recordEmbedding(
  run: SyncRun,
  engineState: EngineState,
  table: lancedb.Table | undefined,
  dimension: number | undefined,
): Promise<void> {
  const model = run.ctx.embedder.model;
  if (dimension) {
    engineState.embedding = { model, dimension };
    return;
  }
  if (engineState.embedding || !table) return;
  const width = await schemaDimension(table);
  if (width > 0) engineState.embedding = { model, dimension: width };
}

async function reconcile(run: SyncRun): Promise<void> {
  const { ctx, s3, companion } = run;
  const dataset = await loadDataset(run);
  const { engineState, table } = dataset;
  const indexed = table ? await readIndexedObjects(table) : new Map<string, IndexedObject>();
  const source = await listSourceObjects(s3, run.target.bucketName);
  const plan = planSync(source, indexed, engineState.skipped, ctx.config.maxObjectBytes);
  const progress = { objectsTotal: plan.toIndex.length, objectsDone: 0, chunksWritten: 0 };
  run.state.progress = progress;
  // Never indexed and nothing to index: nothing to write either.
  if (!dataset.db && plan.toIndex.length === 0) {
    run.state.lastSyncedAt = new Date().toISOString();
    return;
  }
  if (!dataset.db) {
    await ensureBucket(s3, companion);
    dataset.db = await connectDataset(run.storage, companion);
  }

  const writer = new BatchWriter(dataset.db, table, ctx.config.flushRows, progress);
  const dimension = await indexObjects(run, { plan, writer, indexed, engineState });
  dataset.table = writer.table;
  if (writer.table && plan.removed.length > 0) await deleteObjectRows(writer.table, plan.removed);
  const changed = plan.toIndex.length > 0 || plan.removed.length > 0;
  const syncedAt = new Date();
  if (writer.table) await finishDataset(run, writer.table, changed, syncedAt);

  const present = new Set(source.map((object) => object.key));
  for (const key of Object.keys(engineState.skipped)) {
    if (!present.has(key)) delete engineState.skipped[key];
  }
  await recordEmbedding(run, engineState, writer.table, dimension);
  await saveState(run, dataset, changed, syncedAt);
  ctx.log('info', 'sync_done', {
    bucket: run.target.bucketName,
    indexed: plan.toIndex.length,
    removed: plan.removed.length,
    chunks: progress.chunksWritten,
  });
}

/**
 * Runs at most one sync per target. Sync state lives in memory: the engine is
 * one container, and the dataset itself is the durable record.
 */
export class SyncManager {
  readonly #ctx: EngineContext;
  readonly #states = new Map<string, TargetSyncState>();
  /** Drops running per companion bucket; no sync may start while one runs. */
  readonly #drops = new Map<string, number>();

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
    if (this.#drops.has(companion)) {
      throw new EngineError(409, 'DROP_IN_PROGRESS', 'The index for this bucket is being deleted');
    }

    const state: TargetSyncState = {
      syncState: 'syncing',
      lastSyncedAt: existing?.lastSyncedAt,
      cancelled: false,
      progress: { objectsTotal: 0, objectsDone: 0, chunksWritten: 0 },
    };
    const storage = storageFor(target, this.#ctx.config.s3EndpointOverrides);
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
        // The status response carries a short summary; the log keeps the full error.
        state.lastSyncError = summarizeError(error);
        this.#ctx.log('error', 'sync_failed', {
          bucket: target.bucketName,
          ...errorLogFields(error),
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

  /**
   * Stop any running sync, then run `drop` with no sync able to start until it
   * settles, so a sync cannot recreate the dataset while it is being deleted.
   */
  async whileDropping<T>(companion: string, drop: () => Promise<T>): Promise<T> {
    this.#drops.set(companion, (this.#drops.get(companion) ?? 0) + 1);
    try {
      await this.cancel(companion);
      return await drop();
    } finally {
      const left = (this.#drops.get(companion) ?? 1) - 1;
      if (left > 0) this.#drops.set(companion, left);
      else this.#drops.delete(companion);
    }
  }

  /** Wait for every running sync (tests and shutdown). */
  async idle(): Promise<void> {
    const running = [...this.#states.values()].flatMap((state) =>
      state.running ? [state.running] : [],
    );
    await Promise.all(running);
  }
}
