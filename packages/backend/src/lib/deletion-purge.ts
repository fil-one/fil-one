import {
  DeleteItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { S3VectorsStore } from '@filone/rag-shared';
import type { S3Region } from '@filone/shared';
import { Resource } from 'sst';
import {
  clearCheckpoint,
  deleteManifestEntry,
  loadManifest,
} from '../jobs/rag-indexer-manifest.js';
import { getDynamoClient } from './ddb-client.js';
import { RAGKeys } from './dynamo-records.js';
import type { DeletionMember, DeletionRecord } from './deletion-record.js';
import { RagApiKeyKeys } from './rag-api-keys.js';

type Item = Record<string, AttributeValue>;
type Cursor = Record<string, AttributeValue> | undefined;

/**
 * Deletes every FilOne-owned row for a deleted org. Idempotent and resumable:
 * the worker re-runs the whole sequence on each pass, and a pass that dies
 * partway leaves a strictly smaller partition for the next one, so no checkpoint
 * is needed.
 *
 * Two rows deliberately survive: `ORG#{orgId}/DELETION` is the erasure receipt,
 * and `SUB#{sub}/IDENTITY` is tombstoned rather than removed because
 * `createNewUserAndOrg` claims that key with `attribute_not_exists(pk)` —
 * deleting it would let the same Auth0 sub sign up again into a fresh org.
 *
 * Out of scope, and not findable rather than forgotten: `EMAIL_NORM#{email}` and
 * `ALLOWLIST#{email}` are keyed by an address, and no row stores a user's email,
 * so neither key can be rebuilt from this record. `WEBHOOK#{eventId}` carries no
 * org attribute at all and expires on its own TTL.
 */
export async function purgeOrgRecords(orgId: string, record: DeletionRecord): Promise<void> {
  const orgRows = await readOrgPartition(orgId);

  await deleteRagKeyLookups(orgRows);
  await purgeRagState(orgId);
  await purgeBilling(orgId, record.members);
  await deleteOrgPartition(orgRows);
  await purgeMembers(record.members);

  // Last: it holds the tenant ids a resumed pass would need, and its `deleting`
  // attribute is the fence keeping concurrent writers out until then.
  await deleteRow(Resource.UserInfoTable.name, { pk: `ORG#${orgId}`, sk: 'PROFILE' });
}

/**
 * The whole `ORG#{orgId}` partition, read once and used twice: to harvest the
 * RAG token hashes, and to delete the rows. Enumerating by pk rather than by a
 * list of sks is what keeps this correct when someone adds a new sk shape.
 */
async function readOrgPartition(orgId: string): Promise<Item[]> {
  return collectPages((cursor) =>
    getDynamoClient().send(
      new QueryCommand({
        TableName: Resource.UserInfoTable.name,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: marshall({ ':pk': `ORG#${orgId}` }),
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    ),
  );
}

/**
 * Before the partition, not after: a lookup row's pk derives from the
 * `tokenHash` on the `RAGKEY#` row, so deleting those first leaves rows nothing
 * can ever find again, each holding the hash of a credential.
 */
async function deleteRagKeyLookups(orgRows: Item[]): Promise<void> {
  for (const row of orgRows) {
    const tokenHash = row.tokenHash?.S;
    if (!tokenHash) continue;
    await deleteRow(Resource.UserInfoTable.name, {
      pk: RagApiKeyKeys.lookupPk(tokenHash),
      sk: RagApiKeyKeys.lookupSk(),
    });
  }
}

/**
 * RAG state lives under `BUCKET#{orgId}#{region}#{bucket}` and
 * `INDEXER_CHECKPOINT#{orgId}#…`. The orgId is inside the pk and Query needs an
 * exact hash key, so this is the one Scan in the purge — the same shape
 * rag-indexer-orchestrator already runs against this table on every pass.
 */
async function purgeRagState(orgId: string): Promise<void> {
  const pks = await collectPages((cursor) =>
    getDynamoClient().send(
      new ScanCommand({
        TableName: Resource.RagIndexerTable.name,
        FilterExpression: 'begins_with(pk, :bucket) OR begins_with(pk, :checkpoint)',
        ProjectionExpression: 'pk',
        ExpressionAttributeValues: marshall({
          ':bucket': `BUCKET#${orgId}#`,
          ':checkpoint': `INDEXER_CHECKPOINT#${orgId}#`,
        }),
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    ),
  );

  // Both pk shapes name the same bucket, so dedupe: one purge per bucket.
  const buckets = new Map<string, { region: S3Region; bucketName: string }>();
  for (const row of pks) {
    const pk = row.pk?.S ?? '';
    const parsed = RAGKeys.parseBucketPk(pk) ?? parseCheckpointPk(pk);
    if (parsed) buckets.set(`${parsed.region}#${parsed.bucketName}`, parsed);
  }

  const vectorStore = new S3VectorsStore(Resource.RagVectorBucket.name);
  for (const { region, bucketName } of buckets.values()) {
    await purgeRagBucket(vectorStore, orgId, region, bucketName);
  }
}

async function purgeRagBucket(
  vectorStore: S3VectorsStore,
  orgId: string,
  region: S3Region,
  bucketName: string,
): Promise<void> {
  // deleteManifestEntry rebuilds the sk with the same builder that wrote it, so
  // an objectKey containing '#' round-trips instead of being mangled.
  const manifest = await loadManifest(orgId, region, bucketName);
  for (const objectKey of manifest.keys()) {
    await deleteManifestEntry(orgId, region, bucketName, objectKey);
  }

  await deleteRow(Resource.RagIndexerTable.name, {
    pk: RAGKeys.bucketPk(orgId, region, bucketName),
    sk: RAGKeys.enablementSk(),
  });
  await clearCheckpoint(orgId, region, bucketName);
  await vectorStore.dropIndex(orgId, region, bucketName);
}

async function purgeBilling(orgId: string, members: DeletionMember[]): Promise<void> {
  const usageRows = await collectPages((cursor) =>
    getDynamoClient().send(
      new QueryCommand({
        TableName: Resource.BillingTable.name,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: marshall({
          ':pk': `ORG#${orgId}`,
          ':prefix': 'USAGE_REPORT#',
        }),
        ProjectionExpression: 'pk, sk',
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    ),
  );

  for (const row of usageRows) {
    await deleteItem(Resource.BillingTable.name, { pk: row.pk!, sk: row.sk! });
  }

  for (const { userId } of members) {
    await deleteRow(Resource.BillingTable.name, {
      pk: `CUSTOMER#${userId}`,
      sk: 'SUBSCRIPTION',
    });
  }
}

/** Everything but the erasure receipt and the profile, which goes last. */
async function deleteOrgPartition(orgRows: Item[]): Promise<void> {
  for (const row of orgRows) {
    const sk = row.sk?.S;
    if (!sk || sk === 'DELETION' || sk === 'PROFILE') continue;
    await deleteItem(Resource.UserInfoTable.name, { pk: row.pk!, sk: row.sk! });
  }
}

async function purgeMembers(members: DeletionMember[]): Promise<void> {
  for (const { userId, sub } of members) {
    await deleteRow(Resource.UserInfoTable.name, { pk: `USER#${userId}`, sk: 'PROFILE' });
    await tombstoneIdentity(sub);
  }
}

/**
 * Strips the row to `deleted` + `deletedAt` and keeps it. `if_not_exists` on
 * deletedAt so a re-drive preserves the first pass's timestamp.
 */
async function tombstoneIdentity(sub: string): Promise<void> {
  await getDynamoClient().send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: `SUB#${sub}`, sk: 'IDENTITY' }),
      UpdateExpression:
        'SET deleted = :true, deletedAt = if_not_exists(deletedAt, :now) ' +
        'REMOVE userId, orgId, emailEntitlementClaimed, createdAt',
      ExpressionAttributeValues: marshall({ ':true': true, ':now': new Date().toISOString() }),
    }),
  );
}

function parseCheckpointPk(
  pk: string,
): { region: S3Region; bucketName: string; orgId: string } | undefined {
  if (!pk.startsWith('INDEXER_CHECKPOINT#')) return undefined;
  return RAGKeys.parseBucketPk(pk.replace('INDEXER_CHECKPOINT#', 'BUCKET#'));
}

async function deleteRow(tableName: string, key: Record<string, string>): Promise<void> {
  await deleteItem(tableName, marshall(key));
}

async function deleteItem(tableName: string, key: Item): Promise<void> {
  await getDynamoClient().send(new DeleteItemCommand({ TableName: tableName, Key: key }));
}

/**
 * Pages a Query or Scan to exhaustion. Three reads here need the same loop; it
 * stays private until a second module wants it.
 */
async function collectPages(
  send: (cursor: Cursor) => Promise<{ Items?: Item[]; LastEvaluatedKey?: Cursor }>,
): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: Cursor;
  do {
    const page = await send(cursor);
    items.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return items;
}
