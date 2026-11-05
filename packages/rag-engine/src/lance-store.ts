import * as lancedb from '@lancedb/lancedb';
import type { RagEngineIndexInfo } from '@filone/shared';
import { Field, FixedSizeList, Float32, Int32, Int64, Schema, Utf8 } from 'apache-arrow';

import {
  TABLE_NAME,
  bucketExists,
  createS3Client,
  datasetUri,
  isNoSuchBucket,
  lanceStorageOptions,
  type StorageContext,
} from './storage.ts';

/**
 * The Lance dataset that holds one bucket's index.
 *
 * Every row is one chunk of one source object and carries what the engine
 * needs to reconcile against the source bucket (`objectKey`, `etag`,
 * `objectSize`), so the dataset describes itself and no other store is needed.
 */
export interface ChunkRow {
  objectKey: string;
  etag: string;
  objectSize: bigint;
  chunkIndex: number;
  text: string;
  vector: number[];
}

export const VECTOR_COLUMN = 'vector';
export const TEXT_COLUMN = 'text';
/** Lance's default names for indexes on these columns. */
export const VECTOR_INDEX_NAME = `${VECTOR_COLUMN}_idx`;
export const FTS_INDEX_NAME = `${TEXT_COLUMN}_idx`;

/** Keys per `objectKey IN (...)` predicate. */
const PREDICATE_BATCH = 200;
/** Rows per HNSW partition; small datasets get one partition. */
const ROWS_PER_PARTITION = 100_000;

export function chunkSchema(dimension: number): Schema {
  return new Schema([
    new Field('objectKey', new Utf8(), false),
    new Field('etag', new Utf8(), false),
    new Field('objectSize', new Int64(), false),
    new Field('chunkIndex', new Int32(), false),
    new Field(TEXT_COLUMN, new Utf8(), false),
    new Field(
      VECTOR_COLUMN,
      new FixedSizeList(dimension, new Field('item', new Float32(), true)),
      false,
    ),
  ]);
}

/** Single-quote a string for a Lance/DataFusion SQL predicate. */
export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function inPredicates(keys: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < keys.length; i += PREDICATE_BATCH) {
    out.push(
      `objectKey IN (${keys
        .slice(i, i + PREDICATE_BATCH)
        .map(sqlQuote)
        .join(', ')})`,
    );
  }
  return out;
}

export function connectDataset(
  storage: StorageContext,
  companionBucket: string,
): Promise<lancedb.Connection> {
  return lancedb.connect(datasetUri(companionBucket), {
    storageOptions: lanceStorageOptions(storage),
  });
}

/**
 * Open the chunks table for reading, optionally checked out at `version`.
 * Returns undefined when the companion bucket or the table does not exist.
 * Never writes: a read path must not create anything.
 */
export async function openTable(
  storage: StorageContext,
  companionBucket: string,
  version?: number,
): Promise<lancedb.Table | undefined> {
  // One HEAD instead of Lance retrying a listing of a bucket that is not there.
  const s3 = createS3Client(storage);
  try {
    if (!(await bucketExists(s3, companionBucket))) return undefined;
  } finally {
    s3.destroy();
  }
  let names: string[];
  let db: lancedb.Connection;
  try {
    db = await connectDataset(storage, companionBucket);
    names = await db.tableNames();
  } catch (error) {
    if (isNoSuchBucket(error)) return undefined;
    throw error;
  }
  if (!names.includes(TABLE_NAME)) return undefined;
  const table = await openCommittedTable(db);
  if (table && version !== undefined) {
    try {
      await table.checkout(version);
    } catch (error) {
      if (isMissingManifest(error)) throw new VersionNotFoundError(version);
      throw error;
    }
  }
  return table;
}

/** Raised when a requested dataset version has no manifest. */
export class VersionNotFoundError extends Error {
  constructor(version: number) {
    super(`Version ${version} does not exist`);
    this.name = 'VersionNotFoundError';
  }
}

/** Lance's error for a dataset path or version manifest that is not there. */
export function isMissingManifest(error: unknown): boolean {
  return error instanceof Error && /not found/i.test(error.message);
}

/**
 * Open the chunks table from a connection that lists it. Data files without a
 * committed manifest (a first commit that failed part way) are not a table
 * yet: undefined, and the next `createTable` writes over them.
 */
export async function openCommittedTable(
  db: lancedb.Connection,
): Promise<lancedb.Table | undefined> {
  try {
    return await db.openTable(TABLE_NAME);
  } catch (error) {
    if (isMissingManifest(error)) return undefined;
    throw error;
  }
}

export interface IndexedObject {
  etag: string;
  size: number;
}

/** Distinct source objects in the dataset, with the ETag and size they were indexed at. */
export async function readIndexedObjects(
  table: lancedb.Table,
): Promise<Map<string, IndexedObject>> {
  const rows = (await table.query().select(['objectKey', 'etag', 'objectSize']).toArray()) as {
    objectKey: string;
    etag: string;
    objectSize: bigint | number;
  }[];
  const out = new Map<string, IndexedObject>();
  for (const row of rows) {
    if (!out.has(row.objectKey)) {
      out.set(row.objectKey, { etag: row.etag, size: Number(row.objectSize) });
    }
  }
  return out;
}

/**
 * Commit one batch of chunks. Chunks of objects in `replaceKeys` replace every
 * existing row for those objects in the same commit, so a reader never sees an
 * object half-updated. The first batch creates the table and its full-text
 * index, so every later version can serve full-text search.
 */
export async function writeChunks(
  db: lancedb.Connection,
  table: lancedb.Table | undefined,
  rows: ChunkRow[],
  replaceKeys: string[],
): Promise<lancedb.Table> {
  const first = rows[0];
  if (!first) throw new Error('writeChunks needs at least one row');
  if (!table) {
    const created = await db.createTable(TABLE_NAME, rows as unknown as Record<string, unknown>[], {
      schema: chunkSchema(first.vector.length),
      mode: 'create',
    });
    await created.createIndex(TEXT_COLUMN, { config: textIndexConfig() });
    return created;
  }
  const data = rows as unknown as Record<string, unknown>[];
  if (replaceKeys.length === 0) {
    await table.add(data);
    return table;
  }
  if (replaceKeys.length > PREDICATE_BATCH) {
    // One predicate per batch keeps SQL small; split oversized replacements.
    throw new Error(`writeChunks replaces at most ${PREDICATE_BATCH} objects per commit`);
  }
  await table
    .mergeInsert(['objectKey', 'chunkIndex'])
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .whenNotMatchedBySourceDelete({
      where: inPredicates(replaceKeys)[0] ?? 'false',
    })
    .execute(data);
  return table;
}

/** Remove every chunk of the given source objects. */
export async function deleteObjectRows(table: lancedb.Table, keys: string[]): Promise<void> {
  for (const predicate of inPredicates(keys)) await table.delete(predicate);
}

/**
 * The full-text index. Token positions let it answer phrase queries: LanceDB
 * runs a query wrapped in double quotes as a phrase, which fails without them.
 */
function textIndexConfig(): lancedb.Index {
  return lancedb.Index.fts({ withPosition: true });
}

async function vectorIndexConfig(table: lancedb.Table): Promise<lancedb.Index> {
  const rows = await table.countRows();
  return lancedb.Index.hnswSq({
    distanceType: 'cosine',
    numPartitions: Math.max(1, Math.round(rows / ROWS_PER_PARTITION)),
  });
}

/**
 * Bring indexes up to date after a sync: the full-text index always, the
 * vector index once the table has `vectorIndexMinRows` rows (below that a flat
 * scan is exact and fast). `optimize()` then compacts small fragments and folds
 * new rows into both indexes. Old versions are kept for time travel; Lance
 * prunes versions older than its default retention (7 days).
 */
export async function finalizeDataset(
  table: lancedb.Table,
  options: { vectorIndexMinRows: number },
): Promise<void> {
  const missing = await missingIndexes(table, options);
  // `replace` (the default) swaps an outdated text index for the new one.
  if (missing.text) await table.createIndex(TEXT_COLUMN, { config: textIndexConfig() });
  if (missing.vector) {
    await table.createIndex(VECTOR_COLUMN, {
      config: await vectorIndexConfig(table),
    });
  }
  await table.optimize();
}

/**
 * Indexes the latest version should have but lacks: the full-text index
 * always, the vector index from `vectorIndexMinRows` rows. A sync interrupted
 * between its data commits and its index commits leaves one of these missing.
 * A full-text index built without token positions (by an earlier engine)
 * counts as missing, so the next sync rebuilds it for phrase queries.
 */
export async function missingIndexes(
  table: lancedb.Table,
  options: { vectorIndexMinRows: number },
): Promise<{ text: boolean; vector: boolean }> {
  const indexes = await table.listIndices();
  const text = !indexes.some(
    (index) =>
      index.columns.includes(TEXT_COLUMN) &&
      (index.indexDetails as { with_position?: boolean } | undefined)?.with_position !== false,
  );
  const vector =
    !indexes.some((index) => index.columns.includes(VECTOR_COLUMN)) &&
    (await table.countRows()) >= options.vectorIndexMinRows;
  return { text, vector };
}

/**
 * Tag name for the version a sync finished at, e.g. `sync-20261105T100000.123Z`
 * (Lance tags allow only letters, digits, `.`, `-` and `_`).
 */
export function syncTagName(at: Date): string {
  return `sync-${at.toISOString().replace(/[-:]/g, '')}`;
}

/**
 * Tag the latest version as a finished sync. Tagged versions are the ones a
 * caller should offer for time travel: every one has the full-text index, and
 * Lance's cleanup keeps tagged versions past its retention window.
 */
export async function tagSyncVersion(
  table: lancedb.Table,
  at: Date,
  keep = SYNC_TAGS_KEPT,
): Promise<void> {
  const tags = await table.tags();
  await tags.create(syncTagName(at), await table.version());
  await pruneSyncTags(table, keep);
}

/** Sync tags kept for time travel; older versions fall to Lance's 7-day cleanup. */
export const SYNC_TAGS_KEPT = 30;

/**
 * Delete all but the newest `keep` sync tags. A tagged version keeps its data
 * files forever, so without this a bucket that changes often grows its
 * companion bucket without bound. Tag names sort by time.
 */
export async function pruneSyncTags(table: lancedb.Table, keep: number): Promise<void> {
  const tags = await table.tags();
  const names = Object.keys(await tags.list())
    .filter((name) => name.startsWith('sync-'))
    .sort()
    .reverse();
  for (const name of names.slice(keep)) await tags.delete(name);
}

/** Vector width from the table schema; 0 when the schema has no vector column. */
export async function schemaDimension(table: lancedb.Table): Promise<number> {
  const field = (await table.schema()).fields.find((f) => f.name === VECTOR_COLUMN);
  const size = (field?.type as { listSize?: number } | undefined)?.listSize;
  return typeof size === 'number' ? size : 0;
}

/**
 * Whether any index leaves rows out: a sync that committed rows and stopped
 * before `finalizeDataset` folded them in.
 */
export async function hasUnindexedRows(table: lancedb.Table): Promise<boolean> {
  for (const index of await table.listIndices()) {
    if (((await table.indexStats(index.name))?.numUnindexedRows ?? 0) > 0) return true;
  }
  return false;
}

/** Indexes on the table at its checked-out version, with coverage. */
export async function describeIndexes(table: lancedb.Table): Promise<RagEngineIndexInfo[]> {
  const indexes = await table.listIndices();
  return Promise.all(
    indexes.map(async (index) => {
      const stats = await table.indexStats(index.name);
      return {
        name: index.name,
        type: stats?.indexType ?? index.indexType,
        columns: index.columns,
        indexedRows: stats?.numIndexedRows,
        unindexedRows: stats?.numUnindexedRows,
      };
    }),
  );
}

/** Drop the dataset. Returns false when there was nothing to drop. */
export async function dropTable(
  storage: StorageContext,
  companionBucket: string,
): Promise<boolean> {
  // One HEAD instead of Lance retrying a listing of a bucket that is not there.
  const s3 = createS3Client(storage);
  try {
    if (!(await bucketExists(s3, companionBucket))) return false;
  } finally {
    s3.destroy();
  }
  try {
    const db = await connectDataset(storage, companionBucket);
    if (!(await db.tableNames()).includes(TABLE_NAME)) return false;
    await db.dropTable(TABLE_NAME);
    return true;
  } catch (error) {
    if (isNoSuchBucket(error)) return false;
    throw error;
  }
}
