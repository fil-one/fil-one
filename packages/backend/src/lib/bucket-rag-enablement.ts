import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import type { BucketRagEnablementResponse, S3Region } from '@filone/shared';
import { getDynamoClient } from './ddb-client.js';
import {
  RAGKeys,
  type BucketRAGEnablementRecord,
  type BucketRAGStatus,
  type BucketRAGSyncState,
} from './dynamo-records.js';

const dynamo = getDynamoClient();

/** Cap persisted error messages so a giant stack never bloats the DDB item. */
const MAX_SYNC_ERROR_LENGTH = 500;

/**
 * Read a bucket's RAG enablement row (`BUCKET#{region}#{bucketName}` / `RAG`).
 *
 * The enablement records are keyed by bucket *name* — the indexer worker treats
 * `bucketId === bucket.bucketName` (see rag-indexer-worker), so handlers keep
 * the same convention. Returns `undefined` when RAG was never enabled for the
 * bucket so callers can render a never-synced state gracefully.
 */
export async function getBucketRagEnablement(
  region: S3Region,
  bucketName: string,
): Promise<BucketRAGEnablementRecord | undefined> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: RAGKeys.bucketPk(region, bucketName) },
        sk: { S: RAGKeys.enablementSk() },
      },
    }),
  );
  if (!Item) return undefined;
  return unmarshall(Item) as BucketRAGEnablementRecord;
}

/**
 * Create or update a bucket's RAG enablement row, flipping `status` to `active`
 * or `disabled`. Preserves indexer-owned telemetry (`syncState`, `filesIndexed`,
 * `indexSize`, `lastSyncedAt`, `lastSyncError`) and the original `createdAt` from
 * any existing record, and denormalizes `orgId` onto the row so the indexer
 * orchestrator can group RAG-enabled buckets by org without a second lookup (see
 * dynamo-records). `status` (enablement) is decoupled from `syncState` (sync
 * progress): toggling enablement never disturbs the indexer's sync state.
 */
export async function setBucketRagEnablement(args: {
  region: S3Region;
  bucketName: string;
  orgId: string;
  enabled: boolean;
  existing: BucketRAGEnablementRecord | undefined;
}): Promise<BucketRAGEnablementRecord> {
  const { region, bucketName, orgId, enabled, existing } = args;
  const now = new Date().toISOString();
  const status: BucketRAGStatus = enabled ? 'active' : 'disabled';

  const record: BucketRAGEnablementRecord = {
    pk: RAGKeys.bucketPk(region, bucketName),
    sk: RAGKeys.enablementSk(),
    orgId,
    status,
    ...(existing?.syncState ? { syncState: existing.syncState } : {}),
    filesIndexed: existing?.filesIndexed ?? 0,
    indexSize: existing?.indexSize ?? 0,
    ...(existing?.lastSyncedAt ? { lastSyncedAt: existing.lastSyncedAt } : {}),
    ...(existing?.lastSyncError ? { lastSyncError: existing.lastSyncError } : {}),
    ...(existing?.settings ? { settings: existing.settings } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await dynamo.send(
    new PutItemCommand({
      TableName: Resource.UserInfoTable.name,
      Item: marshall(record, { removeUndefinedValues: true }),
    }),
  );

  return record;
}

/**
 * Project a DynamoDB enablement record (or its absence) into the API response
 * shape. A missing record means RAG was never enabled — reported as `disabled`
 * with zeroed telemetry.
 */
export function toEnablementResponse(
  record: BucketRAGEnablementRecord | undefined,
): BucketRagEnablementResponse {
  // Enablement (source of truth) and sync progress are reported as separate
  // fields: a syncing/errored bucket whose `status` is still `active` stays
  // enabled/queryable. A missing record means never-enabled → disabled.
  const status: BucketRAGStatus = record?.status ?? 'disabled';
  const syncState: BucketRAGSyncState | undefined = record?.syncState;
  return {
    enabled: status === 'active',
    status,
    ...(syncState ? { syncState } : {}),
    filesIndexed: record?.filesIndexed ?? 0,
    indexSize: record?.indexSize ?? 0,
    ...(record?.lastSyncedAt ? { lastSyncedAt: record.lastSyncedAt } : {}),
    // Surface the failure reason only when the last sync actually errored.
    ...(syncState === 'error' && record?.lastSyncError
      ? { lastSyncError: record.lastSyncError }
      : {}),
  };
}

/**
 * Telemetry update written by the indexer (FIL-556) at the boundaries of a
 * bucket run. It writes ONLY the `syncState` (sync progress) field and the
 * counters — never the enablement `status`, which it must leave untouched so
 * liveness (orchestrator scan / worker gate) and the UI enabled-check are
 * unaffected:
 *   - `syncing`: only `{ syncState }` — marks the run in flight.
 *   - `idle`:    the success snapshot `{ syncState, filesIndexed, indexSize, lastSyncedAt }`.
 *   - `error`:   `{ syncState, lastSyncError }` — records the failure reason.
 */
export interface BucketTelemetryUpdate {
  /** Sync progress to record; NOT the enablement `status` (left untouched). */
  syncState: BucketRAGSyncState;
  /** Absolute snapshot: count of objects with >=1 indexed chunk (manifest size). */
  filesIndexed?: number;
  /** Absolute snapshot: sum of indexed source-object bytes. */
  indexSize?: number;
  /** ISO-8601 completion time of the run; set on success. */
  lastSyncedAt?: string;
  /** Failure reason; set with `syncState: 'error'`. */
  lastSyncError?: string;
}

/**
 * Atomically update a bucket's RAG sync telemetry on the existing enablement row
 * (`BUCKET#{bucketName}` / `RAG`) via a single DynamoDB `UpdateItemCommand`.
 *
 * A single `UpdateItem` is applied atomically by DynamoDB — there is no
 * read-modify-write window — so concurrent indexer workers cannot clobber each
 * other or lose an update. `filesIndexed` and `indexSize` are absolute snapshots
 * of a completed reconciliation (the manifest count / summed source-object
 * bytes), so they are written with `SET` (last-write-wins is correct and
 * desirable for the freshest snapshot); a relative `ADD` would double-count
 * across runs. Timestamps and `syncState` likewise use `SET`. The failure reason
 * is `SET` on error and `REMOVE`d on any non-error update so a stale message
 * never lingers once a later sync succeeds.
 *
 * The enablement `status` field is NEVER written here: enablement is the source
 * of truth for liveness (orchestrator scan / worker gate) and the UI enabled
 * check, and decoupling it from sync progress is the whole point of `syncState`.
 *
 * A `ConditionExpression` (`attribute_exists(pk)`) guards against writing
 * telemetry to a bucket whose enablement row was deleted/never created — only
 * RAG-enabled buckets carry the row — so the update is a safe no-op otherwise.
 */
export async function updateBucketTelemetry(
  region: S3Region,
  bucketName: string,
  update: BucketTelemetryUpdate,
): Promise<void> {
  const now = new Date().toISOString();
  const sets: string[] = ['syncState = :syncState', 'updatedAt = :now'];
  const removes: string[] = [];
  const values: Record<string, AttributeValue> = {
    ':syncState': { S: update.syncState },
    ':now': { S: now },
  };

  if (typeof update.filesIndexed === 'number') {
    sets.push('filesIndexed = :files');
    values[':files'] = { N: String(update.filesIndexed) };
  }
  if (typeof update.indexSize === 'number') {
    sets.push('indexSize = :size');
    values[':size'] = { N: String(update.indexSize) };
  }
  if (update.lastSyncedAt) {
    sets.push('lastSyncedAt = :synced');
    values[':synced'] = { S: update.lastSyncedAt };
  }
  if (update.syncState === 'error' && update.lastSyncError) {
    sets.push('lastSyncError = :err');
    values[':err'] = { S: update.lastSyncError.slice(0, MAX_SYNC_ERROR_LENGTH) };
  } else {
    // Clear any stale failure reason once we are no longer in an error state.
    removes.push('lastSyncError');
  }

  const updateExpression =
    `SET ${sets.join(', ')}` + (removes.length > 0 ? ` REMOVE ${removes.join(', ')}` : '');

  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: {
          pk: { S: RAGKeys.bucketPk(region, bucketName) },
          sk: { S: RAGKeys.enablementSk() },
        },
        UpdateExpression: updateExpression,
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: values,
      }),
    );
  } catch (error) {
    // The row only exists for RAG-enabled buckets; a missing row means the
    // bucket was disabled mid-run. Swallow that specific case so telemetry never
    // resurrects a disabled bucket's row (and never fails the indexer for it).
    // Match on the SDK exception type (with a name fallback for robustness).
    if (
      error instanceof ConditionalCheckFailedException ||
      (error instanceof Error && error.name === 'ConditionalCheckFailedException')
    ) {
      return;
    }
    throw error;
  }
}
