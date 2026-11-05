import type * as lancedb from '@lancedb/lancedb';
import type {
  RagEngineDatasetInfo,
  RagEngineStatus,
  RagEngineTarget,
  RagEngineVersion,
} from '@filone/shared';

import { readEngineState, type EngineState } from './engine-state.ts';
import type { EngineContext } from './engine-context.ts';
import { describeIndexes, openTable, readIndexedObjects, schemaDimension } from './lance-store.ts';
import {
  TABLE_NAME,
  companionBucketName,
  createS3Client,
  datasetUri,
  storageFor,
} from './storage.ts';
import type { SyncManager, TargetSyncState } from './sync.ts';

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

/** The status from what the engine holds in memory, without reading storage. */
export function memoryStatus(memory: TargetSyncState | undefined): RagEngineStatus {
  return {
    syncState: memory?.syncState ?? 'idle',
    lastSyncedAt: memory?.lastSyncedAt,
    lastSyncError: memory?.lastSyncError,
    progress: memory?.syncState === 'syncing' ? memory.progress : undefined,
    filesIndexed: 0,
    indexedBytes: 0,
  };
}

export async function buildStatus(
  ctx: EngineContext,
  syncs: SyncManager,
  target: RagEngineTarget,
): Promise<RagEngineStatus> {
  const companion = companionBucketName(target.orgId, target.region, target.bucketName);
  const storage = storageFor(target, ctx.config.s3EndpointOverrides);
  const memory = syncs.get(companion);
  const s3 = createS3Client(storage);
  try {
    const [table, state] = await Promise.all([
      openTable(storage, companion),
      readEngineState(s3, companion),
    ]);
    const status = memoryStatus(memory);
    status.lastSyncedAt ??= state.lastSyncedAt;
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

/**
 * The versions worth offering for time travel, newest first, with their tags:
 * the latest, and every version a sync finished at (tagged `sync-…`). The
 * versions in between are partial commits of a running sync, and the first one
 * has no full-text index yet.
 */
export async function listVersions(
  ctx: EngineContext,
  target: RagEngineTarget,
): Promise<RagEngineVersion[]> {
  const companion = companionBucketName(target.orgId, target.region, target.bucketName);
  const table = await openTable(storageFor(target, ctx.config.s3EndpointOverrides), companion);
  if (!table) return [];
  const [versions, tags] = await Promise.all([
    table.listVersions(),
    table.tags().then((t) => t.list()),
  ]);
  const tagsByVersion = new Map<number, string[]>();
  for (const [tag, info] of Object.entries(tags)) {
    tagsByVersion.set(info.version, [...(tagsByVersion.get(info.version) ?? []), tag]);
  }
  const latest = Math.max(...versions.map((v) => v.version));
  return versions
    .filter(
      (v) =>
        v.version === latest ||
        tagsByVersion.get(v.version)?.some((tag) => tag.startsWith('sync-')),
    )
    .map((v) => ({
      version: v.version,
      timestamp: v.timestamp.toISOString(),
      ...(tagsByVersion.has(v.version) ? { tags: tagsByVersion.get(v.version) } : {}),
    }))
    .sort((a, b) => b.version - a.version);
}
