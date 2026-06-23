import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import type { BucketRagEnablementResponse } from '@filone/shared';
import { getDynamoClient } from './ddb-client.js';
import { RAGKeys, type BucketRAGEnablementRecord, type BucketRAGStatus } from './dynamo-records.js';

const dynamo = getDynamoClient();

/**
 * Read a bucket's RAG enablement row (`BUCKET#{bucketName}` / `RAG`).
 *
 * The enablement records are keyed by bucket *name* — the indexer worker treats
 * `bucketId === bucket.bucketName` (see rag-indexer-worker), so handlers keep
 * the same convention. Returns `undefined` when RAG was never enabled for the
 * bucket so callers can render a never-synced state gracefully.
 */
export async function getBucketRagEnablement(
  bucketName: string,
): Promise<BucketRAGEnablementRecord | undefined> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: RAGKeys.bucketPk(bucketName) },
        sk: { S: RAGKeys.enablementSk() },
      },
    }),
  );
  if (!Item) return undefined;
  return unmarshall(Item) as BucketRAGEnablementRecord;
}

/**
 * Create or update a bucket's RAG enablement row, flipping `status` to `active`
 * or `disabled`. Preserves telemetry (`filesIndexed`, `indexSize`,
 * `lastSyncedAt`) and the original `createdAt` from any existing record, and
 * denormalizes `orgId` onto the row so the indexer orchestrator can group
 * RAG-enabled buckets by org without a second lookup (see dynamo-records).
 */
export async function setBucketRagEnablement(args: {
  bucketName: string;
  orgId: string;
  enabled: boolean;
  existing: BucketRAGEnablementRecord | undefined;
}): Promise<BucketRAGEnablementRecord> {
  const { bucketName, orgId, enabled, existing } = args;
  const now = new Date().toISOString();
  const status: BucketRAGStatus = enabled ? 'active' : 'disabled';

  const record: BucketRAGEnablementRecord = {
    pk: RAGKeys.bucketPk(bucketName),
    sk: RAGKeys.enablementSk(),
    orgId,
    status,
    filesIndexed: existing?.filesIndexed ?? 0,
    indexSize: existing?.indexSize ?? 0,
    ...(existing?.lastSyncedAt ? { lastSyncedAt: existing.lastSyncedAt } : {}),
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
  const status: BucketRAGStatus = record?.status ?? 'disabled';
  return {
    enabled: status === 'active',
    status,
    filesIndexed: record?.filesIndexed ?? 0,
    indexSize: record?.indexSize ?? 0,
    ...(record?.lastSyncedAt ? { lastSyncedAt: record.lastSyncedAt } : {}),
  };
}
