import {
  BatchWriteItemCommand,
  QueryCommand,
  ScanCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import pRetry, { type Options as RetryOptions } from 'p-retry';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { UsageReportKeys } from './dynamo-records.js';
import { RagApiKeyKeys } from './rag-api-keys.js';

// ---------------------------------------------------------------------------
// Row-level mechanics of the account purge (FIL-112)
// ---------------------------------------------------------------------------
//
// Enumerating the rows a teardown may delete, and deleting them. Separated from
// the teardown that orchestrates it because this half carries its own safety
// invariant — nothing outside the purgeable prefixes is ever deleted — and that
// invariant is easier to hold, and to test, on its own.

const dynamo = getDynamoClient();

/**
 * Partition-key prefixes the purge is allowed to delete, per table. Anything
 * outside them — e.g. `EMAIL_NORM#`, the FIL-422 trial-claim record that must
 * survive account deletion — is structurally undeletable: the guard throws
 * before a delete is issued. The trailing `#` matters: it stops a prefix
 * colliding with a longer key family (`ORG#` never matches `ORGANIZATION#`).
 */
export const PURGEABLE_USER_INFO_PK_PREFIXES = ['ORG#', 'USER#', 'SUB#', 'RAGKEYHASH#'] as const;

// `ORG#` covers the usage-reporting worker's BillingTable `ORG#{orgId}` /
// `USAGE_REPORT#{date}` audit rows. The trailing `#` keeps this away from
// `ORG_TOMBSTONE#`, the PII-free customer reference that must OUTLIVE the purge.
export const PURGEABLE_BILLING_PK_PREFIXES = ['CUSTOMER#', 'DELETION_CHALLENGE#', 'ORG#'] as const;

/** Blast-radius guard: refuses any purge target outside the purgeable prefixes. */
export function assertPurgeablePk(pk: string, prefixes: readonly string[]): void {
  if (!prefixes.some((prefix) => pk.startsWith(prefix))) {
    throw new Error(`Refusing to purge key outside the purgeable prefixes: ${pk}`);
  }
}

/**
 * RAG API keys write a `RAGKEYHASH#{sha256}/LOOKUP` row alongside the org's
 * `RAGKEY#` row (see lib/rag-api-keys.ts). The ORG# partition purge removes
 * the RAGKEY# rows but not the hash lookups — credential-hash residue that
 * would survive an erasure request forever — so derive each lookup pk from
 * the RAGKEY# rows' stored `tokenHash` and delete them explicitly.
 *
 * Takes the partition snapshot the caller already fetched rather than
 * re-querying: sharing one snapshot with the partition delete is what makes the
 * pairing exact, and running before it is what makes a crash between the two
 * recoverable (see the note at the call site).
 */
export async function purgeRagKeyHashRows(orgRows: Record<string, unknown>[]): Promise<void> {
  const lookupKeys = orgRows
    .filter((row) => typeof row.sk === 'string' && row.sk.startsWith(RagApiKeyKeys.orgSkPrefix()))
    .map((row) => row.tokenHash)
    .filter((tokenHash): tokenHash is string => typeof tokenHash === 'string')
    .map((tokenHash) => ({ pk: RagApiKeyKeys.lookupPk(tokenHash), sk: RagApiKeyKeys.lookupSk() }));
  for (const key of lookupKeys) assertPurgeablePk(key.pk, PURGEABLE_USER_INFO_PK_PREFIXES);
  await batchDelete(Resource.UserInfoTable.name, lookupKeys);
}

/**
 * Delete the org's BillingTable `ORG#{orgId}` audit rows — the usage-reporting
 * worker's `USAGE_REPORT#{date}` items. Nothing else in the teardown touches
 * this partition (the per-member sweep below handles `CUSTOMER#`), so without
 * this the rows outlive the deletion until their TTL. The
 * `ORG_TOMBSTONE#{orgId}` record is a different partition and is untouched.
 *
 * The sk prefix is part of the contract, not an optimization: this is an
 * unrecoverable delete, and querying the bare partition would silently pull any
 * future `ORG#{orgId}` row into its scope the moment someone adds one. A row
 * that should be purged has to be added here deliberately.
 */
export async function purgeBillingOrgRows(orgId: string): Promise<void> {
  const rows = await queryPartition(
    Resource.BillingTable.name,
    `ORG#${orgId}`,
    UsageReportKeys.skPrefix,
  );
  const keys = rows.map((row) => ({ pk: row.pk as string, sk: row.sk as string }));
  for (const key of keys) assertPurgeablePk(key.pk, PURGEABLE_BILLING_PK_PREFIXES);
  await batchDelete(Resource.BillingTable.name, keys);
}

/** Paged Query of the org's UserInfoTable partition. */
export async function queryOrgRows(orgId: string): Promise<Record<string, unknown>[]> {
  return queryPartition(Resource.UserInfoTable.name, `ORG#${orgId}`);
}

/** Paged Query of a partition, optionally narrowed to an sk prefix. */
async function queryPartition(
  tableName: string,
  pk: string,
  skPrefix?: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: tableName,
        // Strongly consistent: a fenced write that committed just before the
        // teardown started must be visible to the purge that deletes it. The
        // resurrection sweep would catch a survivor later, but the primary path
        // should not lean on the backstop.
        ConsistentRead: true,
        KeyConditionExpression: skPrefix ? 'pk = :pk AND begins_with(sk, :skPrefix)' : 'pk = :pk',
        ExpressionAttributeValues: marshall(
          skPrefix ? { ':pk': pk, ':skPrefix': skPrefix } : { ':pk': pk },
        ),
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );
    rows.push(...(result.Items ?? []).map((item) => unmarshall(item)));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return rows;
}

/** One paged full-table Scan matching BOTH of the org's RAG pk prefixes. */
export async function scanRagKeys(orgId: string): Promise<{ pk: string; sk: string }[]> {
  const keys: { pk: string; sk: string }[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: Resource.RagIndexerTable.name,
        // Same reason as queryPartition. On a Scan this doubles the RCU cost;
        // the table is small and a missed row survives the purge, so it is worth it.
        ConsistentRead: true,
        FilterExpression: 'begins_with(pk, :bucketPrefix) OR begins_with(pk, :checkpointPrefix)',
        ExpressionAttributeValues: marshall({
          ':bucketPrefix': `BUCKET#${orgId}#`,
          ':checkpointPrefix': `INDEXER_CHECKPOINT#${orgId}#`,
        }),
        ProjectionExpression: 'pk, sk',
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );
    keys.push(
      ...(result.Items ?? []).map((item) => unmarshall(item) as { pk: string; sk: string }),
    );
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return keys;
}

// UnprocessedItems means DynamoDB is shedding load — retry with exponential
// backoff + jitter instead of hammering it in a tight loop, and give up after
// ~5 attempts (the thrown error keeps the record non-DONE, so the Lambda
// retry / reconciler re-drives the idempotent purge later).
const BATCH_DELETE_RETRY: RetryOptions = { retries: 4, minTimeout: 100, randomize: true };

/**
 * BatchWrite deletes in 25-key chunks, retrying only the UnprocessedItems of
 * each chunk with capped exponential backoff. Exported for direct testing;
 * `retry` is injectable so tests keep timeouts tiny.
 */
export async function batchDelete(
  tableName: string,
  keys: { pk: string; sk: string }[],
  retry: RetryOptions = BATCH_DELETE_RETRY,
): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    let requests = keys
      .slice(i, i + 25)
      .map((key) => ({ DeleteRequest: { Key: marshall({ pk: key.pk, sk: key.sk }) } }));
    await pRetry(async () => {
      const result = await dynamo.send(
        new BatchWriteItemCommand({ RequestItems: { [tableName]: requests } }),
      );
      const unprocessed = (result.UnprocessedItems?.[tableName] ?? []) as typeof requests;
      if (unprocessed.length > 0) {
        // Narrow the next attempt to what's left, then let pRetry back off.
        requests = unprocessed;
        throw new Error(
          `BatchWriteItem left ${unprocessed.length} unprocessed delete(s) for ${tableName}`,
        );
      }
    }, retry);
  }
}
