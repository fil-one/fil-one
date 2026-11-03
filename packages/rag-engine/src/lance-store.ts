import * as lancedb from '@lancedb/lancedb';
import type { RagEngineIndexInfo } from '@filone/shared';
import { Field, FixedSizeList, Float32, Int32, Int64, Schema, Utf8 } from 'apache-arrow';

import {
  TABLE_NAME,
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
  let table: lancedb.Table;
  try {
    table = await db.openTable(TABLE_NAME);
  } catch (error) {
    // Data files without a committed manifest (a first commit that failed)
    // are not a table yet.
    if (error instanceof Error && /not found/i.test(error.message)) return undefined;
    throw error;
  }
  if (version !== undefined) await table.checkout(version);
  return table;
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
    await created.createIndex(TEXT_COLUMN, { config: lancedb.Index.fts() });
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
    .whenNotMatchedBySourceDelete({ where: inPredicates(replaceKeys)[0] ?? 'false' })
    .execute(data);
  return table;
}

/** Remove every chunk of the given source objects. */
export async function deleteObjectRows(table: lancedb.Table, keys: string[]): Promise<void> {
  for (const predicate of inPredicates(keys)) await table.delete(predicate);
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
  const indexes = await table.listIndices();
  if (!indexes.some((index) => index.columns.includes(TEXT_COLUMN))) {
    await table.createIndex(TEXT_COLUMN, { config: lancedb.Index.fts() });
  }
  const hasVectorIndex = indexes.some((index) => index.columns.includes(VECTOR_COLUMN));
  if (!hasVectorIndex && (await table.countRows()) >= options.vectorIndexMinRows) {
    await table.createIndex(VECTOR_COLUMN, { config: await vectorIndexConfig(table) });
  }
  await table.optimize();
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
