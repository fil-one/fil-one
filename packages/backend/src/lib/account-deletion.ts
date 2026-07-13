import {
  BatchWriteItemCommand,
  ConditionalCheckFailedException,
  DeleteItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { DeleteParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { S3VectorsStore } from '@filone/rag-shared';
import { Resource } from 'sst';
import { deleteAuth0User } from './auth0-management.js';
import { getDynamoClient } from './ddb-client.js';
import { deleteDeletionChallenge } from './deletion-challenge.js';
import { readDeletionRecord } from './deletion-record.js';
import {
  DeletionKeys,
  OrgDeletionStatus,
  RAGKeys,
  type OrgDeletionRecord,
  type OrgDeletionStatusValue,
  type OrgTombstoneRecord,
} from './dynamo-records.js';
import { getOrgProfile } from './org-profile.js';
import {
  assertRegionSyncSucceeded,
  getProvisionedRegions,
  syncTenantStatusInProvisionedRegions,
} from './region-helpers.js';
import { getOrchestratorForRegion } from './service-orchestrator-registry.js';
import { getStripeClient } from './stripe-client.js';
import { S3Region } from '@filone/shared';

const dynamo = getDynamoClient();
const ssm = new SSMClient({});

/**
 * Partition-key prefixes the purge is allowed to delete. `EMAIL_NORM#` (the
 * FIL-422 trial-claim record) is structurally undeletable: any key outside
 * this allowlist throws before a delete is issued.
 */
const USER_INFO_PURGE_ALLOWLIST = ['ORG#', 'USER#', 'SUB#'] as const;
const BILLING_PURGE_ALLOWLIST = ['CUSTOMER#', 'DELETION_CHALLENGE#'] as const;

export function assertPurgeAllowed(pk: string, allowlist: readonly string[]): void {
  if (!allowlist.some((prefix) => pk.startsWith(prefix))) {
    throw new Error(`Refusing to purge key outside the allowlist: ${pk}`);
  }
}

/**
 * Run (or resume) the teardown state machine for an org whose deletion was
 * confirmed. Driven by the ORG#{orgId}/DELETION record written by the
 * delete-account handler; every step is idempotent, so a crash at any point
 * is resumed by re-invoking (async Lambda retry or the reconciler cron).
 * A concurrent invocation loses the conditional status advance and exits.
 */
export async function runAccountDeletion(orgId: string): Promise<void> {
  const record = await readDeletionRecord(orgId);
  if (!record) {
    console.warn('[account-deletion] No deletion record; nothing to do', { orgId });
    return;
  }
  if (record.status === OrgDeletionStatus.Done) return;

  await bumpAttemptCount(orgId);

  let status: OrgDeletionStatusValue = record.status;
  while (status !== OrgDeletionStatus.Done) {
    const next = await runStep(orgId, status, record);
    if (next === 'lost-race') {
      console.warn('[account-deletion] Concurrent teardown advanced the state; exiting', {
        orgId,
        status,
      });
      return;
    }
    console.warn('[account-deletion] Step complete', { orgId, from: status, to: next });
    status = next;
  }
  console.warn('[account-deletion] Teardown complete', { orgId });
}

async function runStep(
  orgId: string,
  status: OrgDeletionStatusValue,
  record: OrgDeletionRecord,
): Promise<OrgDeletionStatusValue | 'lost-race'> {
  switch (status) {
    case OrgDeletionStatus.Pending:
      await revokeAllAccessKeys(orgId);
      return advanceStatus(orgId, status, OrgDeletionStatus.KeysRevoked);
    case OrgDeletionStatus.KeysRevoked:
      await disableAllTenants(orgId);
      return advanceStatus(orgId, status, OrgDeletionStatus.TenantsDisabled);
    case OrgDeletionStatus.TenantsDisabled:
      await cancelStripeAndWriteTombstone(orgId, record);
      return advanceStatus(orgId, status, OrgDeletionStatus.StripeCanceled);
    case OrgDeletionStatus.StripeCanceled:
      await deleteAuth0Users(record);
      return advanceStatus(orgId, status, OrgDeletionStatus.Auth0Deleted);
    case OrgDeletionStatus.Auth0Deleted:
      await purgeRagData(orgId);
      return advanceStatus(orgId, status, OrgDeletionStatus.RagPurged);
    case OrgDeletionStatus.RagPurged:
      await purgeRecords(orgId, record);
      return advanceStatus(orgId, status, OrgDeletionStatus.RecordsPurged);
    case OrgDeletionStatus.RecordsPurged:
      return finalize(orgId, record);
    default:
      throw new Error(`Unexpected deletion status "${status}" for org ${orgId}`);
  }
}

// ---------------------------------------------------------------------------
// Steps — each idempotent
// ---------------------------------------------------------------------------

/** Revoke every access key via its owning orchestrator, then delete the row. */
async function revokeAllAccessKeys(orgId: string): Promise<void> {
  const orgProfile = await getOrgProfile(orgId);
  const rows = await queryOrgRows(orgId, 'ACCESSKEY#');

  for (const row of rows) {
    const keyId = (row.sk as string).slice('ACCESSKEY#'.length);
    // Legacy rows without `region` predate FTH → Aurora (mirrors delete-access-key).
    const region = (row.region as S3Region | undefined) ?? S3Region.EuWest1;
    const orchestrator = getOrchestratorForRegion(region);
    const tenantId = orchestrator.isTenantReady(orgProfile);
    if (tenantId) {
      // Contract: idempotent, a missing key is success.
      await orchestrator.deleteAccessKey(tenantId, keyId);
    } else {
      console.warn('[account-deletion] No ready tenant for key; deleting record only', {
        orgId,
        keyId,
        region,
      });
    }
    await dynamo.send(
      new DeleteItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: `ORG#${orgId}`, sk: `ACCESSKEY#${keyId}` }),
      }),
    );
  }
}

/** Set every provisioned tenant (Aurora and FTH alike) to `disabled`. */
async function disableAllTenants(orgId: string): Promise<void> {
  assertRegionSyncSucceeded(await syncTenantStatusInProvisionedRegions(orgId, 'disabled'));
}

async function cancelStripeAndWriteTombstone(
  orgId: string,
  record: OrgDeletionRecord,
): Promise<void> {
  if (record.subscriptionId) {
    try {
      await getStripeClient().subscriptions.cancel(record.subscriptionId);
    } catch (err) {
      if (!isStripeAlreadyCanceled(err)) throw err;
      console.warn('[account-deletion] Subscription already canceled/missing', {
        orgId,
        subscriptionId: record.subscriptionId,
      });
    }
  }

  // The Stripe CUSTOMER is deliberately kept for finance/audit; this
  // PII-free tombstone preserves the reference across the purge.
  const tombstone: OrgTombstoneRecord = {
    pk: DeletionKeys.tombstonePk(orgId),
    sk: DeletionKeys.tombstoneSk(),
    orgId,
    ...(record.stripeCustomerId ? { stripeCustomerId: record.stripeCustomerId } : {}),
    deletedAt: new Date().toISOString(),
  };
  await dynamo.send(
    new PutItemCommand({ TableName: Resource.BillingTable.name, Item: marshall(tombstone) }),
  );
}

function isStripeAlreadyCanceled(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === 'resource_missing' || /canceled/i.test(e.message ?? '');
}

async function deleteAuth0Users(record: OrgDeletionRecord): Promise<void> {
  for (const member of record.members) {
    if (member.sub) await deleteAuth0User(member.sub);
  }
}

/** Drop every S3 Vectors index for the org's buckets and purge RAG rows. */
async function purgeRagData(orgId: string): Promise<void> {
  const vectorStore = new S3VectorsStore(Resource.RagVectorBucket.name);
  const prefixes = [`BUCKET#${orgId}#`, `INDEXER_CHECKPOINT#${orgId}#`];
  const droppedIndexes = new Set<string>();

  for (const prefix of prefixes) {
    const keys = await scanRagKeysByPrefix(prefix);
    for (const key of keys) {
      if (droppedIndexes.has(key.pk)) continue;
      droppedIndexes.add(key.pk);
      await dropVectorIndexForPk(vectorStore, key.pk);
    }
    await batchDelete(Resource.RagIndexerTable.name, keys);
  }
}

/** Drop the S3 Vectors index behind a BUCKET# pk; already-gone is success. */
async function dropVectorIndexForPk(vectorStore: S3VectorsStore, pk: string): Promise<void> {
  const parsed = RAGKeys.parseBucketPk(pk);
  if (!parsed) return;
  try {
    await vectorStore.dropIndex(parsed.orgId, parsed.region, parsed.bucketName);
  } catch (err) {
    // Re-runs after a crash hit indexes that are already gone.
    if ((err as { name?: string }).name !== 'NotFoundException') throw err;
  }
}

async function purgeRecords(orgId: string, record: OrgDeletionRecord): Promise<void> {
  // A tenant setup racing the confirm may have provisioned after the earlier
  // disable pass. Re-check and re-disable before the profile row (the only
  // pointer to the tenant ids) is purged. The `deleting` flag written at
  // confirm time blocks new setups, so this converges.
  const lateRegions = await getProvisionedRegions(orgId);
  if (lateRegions.length > 0) {
    await revokeAllAccessKeys(orgId);
    await disableAllTenants(orgId);
  }

  await deleteTenantSsmParams(orgId, record);

  // UserInfoTable: everything under ORG#{orgId} except the DELETION record.
  const orgRows = await queryOrgRows(orgId);
  const orgKeys = orgRows
    .filter((row) => row.sk !== DeletionKeys.deletionSk())
    .map((row) => ({ pk: row.pk as string, sk: row.sk as string }));
  for (const key of orgKeys) assertPurgeAllowed(key.pk, USER_INFO_PURGE_ALLOWLIST);
  await batchDelete(Resource.UserInfoTable.name, orgKeys);

  for (const member of record.members) {
    const userKey = { pk: `USER#${member.userId}`, sk: 'PROFILE' };
    assertPurgeAllowed(userKey.pk, USER_INFO_PURGE_ALLOWLIST);
    await dynamo.send(
      new DeleteItemCommand({ TableName: Resource.UserInfoTable.name, Key: marshall(userKey) }),
    );

    // The SUB# identity row is kept forever as a tombstone (deleted/deletedAt
    // only) so a stale-but-valid session can never resurrect the account —
    // strip the PII-adjacent attributes instead of deleting the row.
    if (member.sub) {
      assertPurgeAllowed(`SUB#${member.sub}`, USER_INFO_PURGE_ALLOWLIST);
      await dynamo.send(
        new UpdateItemCommand({
          TableName: Resource.UserInfoTable.name,
          Key: marshall({ pk: `SUB#${member.sub}`, sk: 'IDENTITY' }),
          UpdateExpression:
            'SET deleted = :true, deletedAt = if_not_exists(deletedAt, :now) ' +
            'REMOVE userId, orgId, emailEntitlementClaimed, createdAt',
          ExpressionAttributeValues: marshall({ ':true': true, ':now': new Date().toISOString() }),
        }),
      );
    }

    const billingKey = { pk: `CUSTOMER#${member.userId}`, sk: 'SUBSCRIPTION' };
    assertPurgeAllowed(billingKey.pk, BILLING_PURGE_ALLOWLIST);
    await dynamo.send(
      new DeleteItemCommand({ TableName: Resource.BillingTable.name, Key: marshall(billingKey) }),
    );
  }

  await deleteDeletionChallenge(orgId);
}

async function deleteTenantSsmParams(orgId: string, record: OrgDeletionRecord): Promise<void> {
  const stage = process.env.FILONE_STAGE!;
  // Prefer the live profile (it may know tenants provisioned after the
  // snapshot); fall back to the snapshot if the profile is gone.
  const profile = await getOrgProfile(orgId);
  const auroraTenantId = profile?.auroraTenantId?.S ?? record.auroraTenantId;
  const fthTenantId = profile?.fthTenantId?.S ?? record.fthTenantId;

  const names = [
    ...(auroraTenantId
      ? [
          `/filone/${stage}/aurora-portal/tenant-api-key/${auroraTenantId}`,
          `/filone/${stage}/aurora-s3/access-key/${auroraTenantId}`,
        ]
      : []),
    ...(fthTenantId ? [`/filone/${stage}/fth-s3/access-key/${fthTenantId}`] : []),
  ];

  for (const name of names) {
    try {
      await ssm.send(new DeleteParameterCommand({ Name: name }));
    } catch (err) {
      if ((err as { name?: string }).name !== 'ParameterNotFound') throw err;
    }
  }
}

async function finalize(
  orgId: string,
  record: OrgDeletionRecord,
): Promise<OrgDeletionStatusValue | 'lost-race'> {
  // Strip member subs from the audit record — the org's rows are gone, the
  // record stays as the PII-light audit trail of the teardown.
  const strippedMembers = record.members.map(({ userId }) => ({ userId }));
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: DeletionKeys.deletionPk(orgId), sk: DeletionKeys.deletionSk() }),
        UpdateExpression: 'SET #s = :done, members = :members, updatedAt = :now',
        ConditionExpression: '#s = :expected',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: marshall({
          ':done': OrgDeletionStatus.Done,
          ':expected': OrgDeletionStatus.RecordsPurged,
          ':members': strippedMembers,
          ':now': new Date().toISOString(),
        }),
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return 'lost-race';
    throw err;
  }
  return OrgDeletionStatus.Done;
}

// ---------------------------------------------------------------------------
// Record + Dynamo helpers
// ---------------------------------------------------------------------------

async function bumpAttemptCount(orgId: string): Promise<void> {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: DeletionKeys.deletionPk(orgId), sk: DeletionKeys.deletionSk() }),
      UpdateExpression: 'ADD attemptCount :one',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: marshall({ ':one': 1 }),
    }),
  );
}

/**
 * Conditional status advance (mirrors aurora-tenant-setup's advanceStatus):
 * only the invocation holding the expected status moves forward; a loser
 * gets 'lost-race' and exits, leaving the winner to continue.
 */
async function advanceStatus(
  orgId: string,
  expected: OrgDeletionStatusValue,
  next: OrgDeletionStatusValue,
): Promise<OrgDeletionStatusValue | 'lost-race'> {
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: DeletionKeys.deletionPk(orgId), sk: DeletionKeys.deletionSk() }),
        UpdateExpression: 'SET #s = :next, updatedAt = :now',
        ConditionExpression: '#s = :expected',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: marshall({
          ':next': next,
          ':expected': expected,
          ':now': new Date().toISOString(),
        }),
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return 'lost-race';
    throw err;
  }
  return next;
}

/** Paged Query of the org partition, optionally filtered to an sk prefix. */
async function queryOrgRows(orgId: string, skPrefix?: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: Resource.UserInfoTable.name,
        KeyConditionExpression: skPrefix ? 'pk = :pk AND begins_with(sk, :skPrefix)' : 'pk = :pk',
        ExpressionAttributeValues: marshall({
          ':pk': `ORG#${orgId}`,
          ...(skPrefix ? { ':skPrefix': skPrefix } : {}),
        }),
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );
    rows.push(...(result.Items ?? []).map((item) => unmarshall(item)));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return rows;
}

async function scanRagKeysByPrefix(prefix: string): Promise<{ pk: string; sk: string }[]> {
  const keys: { pk: string; sk: string }[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: Resource.RagIndexerTable.name,
        FilterExpression: 'begins_with(pk, :prefix)',
        ExpressionAttributeValues: marshall({ ':prefix': prefix }),
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

/** BatchWrite deletes in 25-key chunks, retrying UnprocessedItems. */
async function batchDelete(tableName: string, keys: { pk: string; sk: string }[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    let requests = keys
      .slice(i, i + 25)
      .map((key) => ({ DeleteRequest: { Key: marshall({ pk: key.pk, sk: key.sk }) } }));
    while (requests.length > 0) {
      const result = await dynamo.send(
        new BatchWriteItemCommand({ RequestItems: { [tableName]: requests } }),
      );
      requests = (result.UnprocessedItems?.[tableName] ?? []) as typeof requests;
    }
  }
}
