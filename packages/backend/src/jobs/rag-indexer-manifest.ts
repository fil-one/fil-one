// DynamoDB persistence for the RAG indexer: the per-object chunk manifest (the
// authoritative list of vector-store keys for each object) and the resumable
// per-bucket continuation checkpoint. Kept separate from the diff/index logic
// so the indexing core stays focused on S3 + the vector store.

import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { RAGKeys, type RagIndexerCheckpointRecord } from '../lib/dynamo-records.js';
import { S3Region } from '@filone/shared';

const dynamo = getDynamoClient();

/** Resumable checkpoints expire after 48h so a wedged bucket eventually re-scans. */
const CHECKPOINT_TTL_SECONDS = 48 * 60 * 60;

/** In-memory view of an object's manifest row. */
export interface ManifestEntry {
  objectKey: string;
  etag: string;
  chunkKeys: string[];
  updatedAt: string;
}

/**
 * Load every object's manifest for a bucket into a map keyed by objectKey.
 * One `begins_with MANIFEST2#` query (paged) returns the authoritative set of
 * indexed objects and their vector-store keys. Scoped by `orgId` so a reused
 * bucket name can never surface another tenant's manifest.
 */
export async function loadManifest(
  orgId: string,
  region: S3Region,
  bucketName: string,
): Promise<Map<string, ManifestEntry>> {
  const manifest = new Map<string, ManifestEntry>();
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: Resource.RagIndexerTable.name,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': { S: RAGKeys.bucketPk(orgId, region, bucketName) },
          ':prefix': { S: RAGKeys.manifestSkPrefix() },
        },
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );

    for (const item of result.Items ?? []) {
      const entry = toManifestEntry(unmarshall(item));
      if (entry) manifest.set(entry.objectKey, entry);
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return manifest;
}

/** Project a raw manifest DDB row into a {@link ManifestEntry}, or null if malformed. */
function toManifestEntry(record: Record<string, unknown>): ManifestEntry | null {
  if (typeof record.objectKey !== 'string' || typeof record.etag !== 'string') return null;
  return {
    objectKey: record.objectKey,
    etag: record.etag,
    chunkKeys: Array.isArray(record.chunkKeys) ? (record.chunkKeys as string[]) : [],
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  };
}

/** Upsert an object's manifest row with its current ETag and vector-store keys. */
export async function saveManifestEntry(
  orgId: string,
  region: S3Region,
  bucketName: string,
  entry: { objectKey: string; etag: string; chunkKeys: string[] },
): Promise<void> {
  const { objectKey, etag, chunkKeys } = entry;
  await dynamo.send(
    new PutItemCommand({
      TableName: Resource.RagIndexerTable.name,
      Item: marshall({
        pk: RAGKeys.bucketPk(orgId, region, bucketName),
        sk: RAGKeys.manifestSk(objectKey),
        objectKey,
        etag,
        chunkKeys,
        chunkCount: chunkKeys.length,
        updatedAt: new Date().toISOString(),
      }),
    }),
  );
}

/** Remove an object's manifest row (after its vectors have been deleted). */
export async function deleteManifestEntry(
  orgId: string,
  region: S3Region,
  bucketName: string,
  objectKey: string,
): Promise<void> {
  await dynamo.send(
    new DeleteItemCommand({
      TableName: Resource.RagIndexerTable.name,
      Key: {
        pk: { S: RAGKeys.bucketPk(orgId, region, bucketName) },
        sk: { S: RAGKeys.manifestSk(objectKey) },
      },
    }),
  );
}

/**
 * Read the resumable checkpoint for a bucket, or `undefined` when none exists
 * (a fresh bucket, or one whose previous run completed). Expired rows are
 * cleaned up by DynamoDB's TTL; a row that is still present but past its TTL is
 * treated as absent so the bucket re-scans from the top.
 */
export async function loadCheckpoint(
  orgId: string,
  region: S3Region,
  bucketName: string,
): Promise<RagIndexerCheckpointRecord | undefined> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.RagIndexerTable.name,
      Key: {
        pk: { S: RAGKeys.checkpointPk(orgId, region, bucketName) },
        sk: { S: RAGKeys.checkpointSk() },
      },
    }),
  );
  if (!result.Item) return undefined;

  const record = unmarshall(result.Item) as RagIndexerCheckpointRecord;
  if (typeof record.ttl === 'number' && record.ttl <= Math.floor(Date.now() / 1000)) {
    return undefined;
  }
  return record;
}

/**
 * Persist the bucket's progress after a page. Passing a `continuationToken`
 * records where to resume; passing `undefined` clears it (the bucket is fully
 * reconciled), which lets the next run start fresh.
 */
export async function saveCheckpoint(
  orgId: string,
  region: S3Region,
  bucketName: string,
  continuationToken: string | undefined,
): Promise<void> {
  await dynamo.send(
    new PutItemCommand({
      TableName: Resource.RagIndexerTable.name,
      Item: marshall(
        {
          pk: RAGKeys.checkpointPk(orgId, region, bucketName),
          sk: RAGKeys.checkpointSk(),
          orgId,
          region,
          bucketName,
          continuationToken,
          lastPageStartedAt: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + CHECKPOINT_TTL_SECONDS,
        },
        { removeUndefinedValues: true },
      ),
    }),
  );
}

/** Drop the checkpoint once a bucket has been fully reconciled. */
export async function clearCheckpoint(
  orgId: string,
  region: S3Region,
  bucketName: string,
): Promise<void> {
  await dynamo.send(
    new DeleteItemCommand({
      TableName: Resource.RagIndexerTable.name,
      Key: {
        pk: { S: RAGKeys.checkpointPk(orgId, region, bucketName) },
        sk: { S: RAGKeys.checkpointSk() },
      },
    }),
  );
}
