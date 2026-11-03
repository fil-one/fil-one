import type * as lancedb from '@lancedb/lancedb';
import type {
  RagEngineDatasetInfo,
  RagEngineStatus,
  RagEngineTarget,
  RagEngineVersion,
} from '@filone/shared';

import { readEngineState, type EngineState } from './engine-state.ts';
import type { EngineContext } from './engine-context.ts';
import { VECTOR_COLUMN, describeIndexes, openTable, readIndexedObjects } from './lance-store.ts';
import {
  TABLE_NAME,
  companionBucketName,
  createS3Client,
  datasetUri,
  storageFor,
} from './storage.ts';
import type { SyncManager } from './sync.ts';

/** Vector width from the table schema, for datasets with no engine state yet. */
async function schemaDimension(table: lancedb.Table): Promise<number> {
  const field = (await table.schema()).fields.find((f) => f.name === VECTOR_COLUMN);
  const size = (field?.type as { listSize?: number } | undefined)?.listSize;
  return typeof size === 'number' ? size : 0;
}

async function datasetInfo(
  table: lancedb.Table,
  companion: string,
  objects: number,
  embedding: RagEngineDatasetInfo['embedding'],
): Promise<RagEngineDatasetInfo> {
  const [version, stats, indexes] = await Promise.all([
    table.version(),
    table.stats(),
    describeIndexes(table),
  ]);
  return {
    uri: `${datasetUri(companion)}/${TABLE_NAME}.lance`,
    companionBucket: companion,
    table: TABLE_NAME,
    version,
    rows: stats.numRows,
    objects,
    storageBytes: stats.totalBytes,
    fragments: stats.fragmentStats.numFragments,
    indexes,
    embedding,
  };
}

function embeddingInfo(
  ctx: EngineContext,
  state: EngineState,
  dimension: number,
): RagEngineDatasetInfo['embedding'] {
  return state.embedding ?? { model: ctx.embedder.model, dimension };
}

export async function buildStatus(
  ctx: EngineContext,
  syncs: SyncManager,
  target: RagEngineTarget,
): Promise<RagEngineStatus> {
  const companion = companionBucketName(target.orgId, target.region, target.bucketName);
  const storage = storageFor(target, ctx.config.s3EndpointOverride);
  const memory = syncs.get(companion);
  const s3 = createS3Client(storage);
  try {
    const [table, state] = await Promise.all([
      openTable(storage, companion),
      readEngineState(s3, companion),
    ]);
    const status: RagEngineStatus = {
      syncState: memory?.syncState ?? 'idle',
      lastSyncedAt: memory?.lastSyncedAt ?? state.lastSyncedAt,
      lastSyncError: memory?.lastSyncError,
      progress: memory?.syncState === 'syncing' ? memory.progress : undefined,
      filesIndexed: 0,
      indexedBytes: 0,
    };
    if (!table) return status;

    const objects = await readIndexedObjects(table);
    status.filesIndexed = objects.size;
    status.indexedBytes = [...objects.values()].reduce((sum, o) => sum + o.size, 0);
    const embedding = embeddingInfo(ctx, state, await schemaDimension(table));
    status.dataset = await datasetInfo(table, companion, objects.size, embedding);
    return status;
  } finally {
    s3.destroy();
  }
}

/** Every version of the dataset, newest first, with any tags pointing at it. */
export async function listVersions(
  ctx: EngineContext,
  target: RagEngineTarget,
): Promise<RagEngineVersion[]> {
  const companion = companionBucketName(target.orgId, target.region, target.bucketName);
  const table = await openTable(storageFor(target, ctx.config.s3EndpointOverride), companion);
  if (!table) return [];
  const [versions, tags] = await Promise.all([
    table.listVersions(),
    table.tags().then((t) => t.list()),
  ]);
  const tagsByVersion = new Map<number, string[]>();
  for (const [tag, info] of Object.entries(tags)) {
    tagsByVersion.set(info.version, [...(tagsByVersion.get(info.version) ?? []), tag]);
  }
  return versions
    .map((v) => ({
      version: v.version,
      timestamp: v.timestamp.toISOString(),
      ...(tagsByVersion.has(v.version) ? { tags: tagsByVersion.get(v.version) } : {}),
    }))
    .sort((a, b) => b.version - a.version);
}
