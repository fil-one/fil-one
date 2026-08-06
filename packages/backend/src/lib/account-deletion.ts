import {
  BatchWriteItemCommand,
  DeleteItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import pRetry, { type Options as RetryOptions } from 'p-retry';
import { S3VectorsStore } from '@filone/rag-shared';
import { Resource } from 'sst';
import { deleteAuth0User } from './auth0-management.js';
import { getDynamoClient } from './ddb-client.js';
import { deleteDeletionChallenge } from './deletion-challenge.js';
import { applyDeletionGuards } from './deletion-guards.js';
import { readDeletionRecord } from './deletion-record.js';
import {
  DeletionKeys,
  OrgDeletionStatus,
  RAGKeys,
  type OrgDeletionBillingCustomer,
  type OrgDeletionRecord,
  type OrgTombstoneRecord,
} from './dynamo-records.js';
import { getOrgProfile } from './org-profile.js';
import { RagApiKeyKeys } from './rag-api-keys.js';
import {
  getRegionsWithTenantIds,
  getRegionsWithTenantIdsForOrg,
  type ProvisionedRegion,
} from './region-helpers.js';
import { getAvailableOrchestrators } from './service-orchestrator-registry.js';
import { getStripeClient } from './stripe-client.js';
import { redactStripeCustomers } from './stripe-redaction.js';

const dynamo = getDynamoClient();

/**
 * Partition-key prefixes the purge is allowed to delete, per table. Anything
 * outside them — e.g. `EMAIL_NORM#`, the FIL-422 trial-claim record that must
 * survive account deletion — is structurally undeletable: the guard throws
 * before a delete is issued. The trailing `#` matters: it stops a prefix
 * colliding with a longer key family (`ORG#` never matches `ORGANIZATION#`).
 */
export const PURGEABLE_USER_INFO_PK_PREFIXES = ['ORG#', 'USER#', 'SUB#', 'RAGKEYHASH#'] as const;
export const PURGEABLE_BILLING_PK_PREFIXES = ['CUSTOMER#', 'DELETION_CHALLENGE#'] as const;

/** Blast-radius guard: refuses any purge target outside the purgeable prefixes. */
export function assertPurgeablePk(pk: string, prefixes: readonly string[]): void {
  if (!prefixes.some((prefix) => pk.startsWith(prefix))) {
    throw new Error(`Refusing to purge key outside the purgeable prefixes: ${pk}`);
  }
}

/**
 * Run (or resume) the teardown for an org whose deletion was confirmed.
 * Driven by the ORG#{orgId}/DELETION record written by the delete-account
 * handler. There is no per-step state machine: every external teardown is
 * idempotent and snapshot-driven, so each invocation simply runs ALL of them
 * concurrently, then purges the DDB records and marks the record DONE. A
 * failure anywhere leaves the record non-DONE and throws after everything
 * settles, so Lambda's async retry / the orchestrator cron re-drives the whole
 * (idempotent) teardown. Concurrent invocations are harmless for the same
 * reason.
 *
 * `record.status` is read as a plain string: legacy records may still carry
 * an old intermediate status (KEYS_REVOKED, TENANTS_DISABLED, ...) — anything
 * that is not DONE means "in progress, run everything".
 */
export async function runAccountDeletion(orgId: string): Promise<void> {
  const record = await readDeletionRecord(orgId);
  if (!record) {
    console.warn('[account-deletion] No deletion record; nothing to do', { orgId });
    return;
  }
  if (record.status === OrgDeletionStatus.Done) return;

  await bumpAttemptCount(orgId);

  // The confirm handler consumes the challenge BEFORE writing the fences; a
  // crash in between leaves this record fence-less with the code burned.
  // Re-applying the (idempotent) fences here closes that gap on every pass.
  await applyDeletionGuards(orgId, record.members);

  // The external teardowns are independent — run them concurrently and only
  // fail after all settle, so one vendor/region outage doesn't block the rest.
  const externals: { name: string; run: () => Promise<void> }[] = [
    { name: 'regions', run: () => deleteAllRegions(orgId, record) },
    { name: 'stripe', run: () => cancelStripeAndWriteTombstone(orgId, record) },
    { name: 'auth0', run: () => deleteAuth0Users(record) },
    { name: 'rag', run: () => purgeRagData(orgId) },
  ];
  const results = await Promise.allSettled(externals.map(({ run }) => run()));
  const failures = results
    .map((result, i) => ({ result, name: externals[i].name }))
    .filter(
      (f): f is { result: PromiseRejectedResult; name: string } => f.result.status === 'rejected',
    );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.result.reason),
      `Account teardown failed for org ${orgId} in: ${failures.map((f) => f.name).join(', ')}`,
    );
  }

  await purgeRecords(orgId, record);
  await markDone(orgId);
  console.warn('[account-deletion] Teardown complete', { orgId });
}

// ---------------------------------------------------------------------------
// External teardowns — each idempotent
// ---------------------------------------------------------------------------

async function cancelStripeAndWriteTombstone(
  orgId: string,
  record: OrgDeletionRecord,
): Promise<void> {
  const customers = record.billingCustomers ?? [];

  for (const customer of customers) {
    for (const subscriptionId of await cancellableSubscriptionIds(orgId, customer)) {
      try {
        await getStripeClient().subscriptions.cancel(subscriptionId);
      } catch (err) {
        if (!isStripeAlreadyCanceled(err)) throw err;
        console.warn('[account-deletion] Subscription already canceled/missing', {
          orgId,
          subscriptionId,
        });
      }
    }
  }

  // The Stripe CUSTOMER objects are kept (finance/audit needs the
  // references), but their PII is erased via a Redaction Job; this PII-free
  // tombstone preserves the customer ids across the purge.
  const customerIds = billingCustomerIds(customers);
  const tombstone: OrgTombstoneRecord = {
    pk: DeletionKeys.tombstonePk(orgId),
    sk: DeletionKeys.tombstoneSk(),
    orgId,
    ...(customerIds.length > 0 ? { stripeCustomerId: customerIds[0] } : {}),
    ...(customerIds.length > 1 ? { stripeCustomerIds: customerIds } : {}),
    deletedAt: new Date().toISOString(),
  };
  await dynamo.send(
    new PutItemCommand({ TableName: Resource.BillingTable.name, Item: marshall(tombstone) }),
  );

  await redactStripeCustomers(orgId, record, customerIds);
}

/** Stripe statuses a subscription can never leave — nothing left to cancel. */
const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'canceled',
  'incomplete_expired',
]);

/**
 * Asks Stripe for the customer's live subscriptions rather than trusting the
 * confirm-time snapshot: one created after the snapshot (see
 * handlers/activate-subscription.ts) would otherwise bill a deleted account
 * forever. Falls back to the snapshotted id only when the entry has no customer
 * id. A `resource_missing` means the customer itself is gone (the
 * customer.deleted trigger), and Stripe already cancelled its subscriptions.
 */
async function cancellableSubscriptionIds(
  orgId: string,
  customer: OrgDeletionBillingCustomer,
): Promise<string[]> {
  if (!customer.stripeCustomerId) {
    return customer.subscriptionId ? [customer.subscriptionId] : [];
  }
  const ids: string[] = [];
  try {
    for await (const subscription of getStripeClient().subscriptions.list({
      customer: customer.stripeCustomerId,
      status: 'all',
      limit: 100,
    })) {
      if (!TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)) ids.push(subscription.id);
    }
  } catch (err) {
    if ((err as { code?: string }).code !== 'resource_missing') throw err;
    console.warn('[account-deletion] Stripe customer already deleted; nothing to cancel', {
      orgId,
      stripeCustomerId: customer.stripeCustomerId,
    });
  }
  return ids;
}

function billingCustomerIds(customers: OrgDeletionBillingCustomer[]): string[] {
  return customers
    .map((c) => c.stripeCustomerId)
    .filter((id): id is string => typeof id === 'string');
}

/**
 * Genuine already-canceled signals only: a missing subscription
 * (`resource_missing`) or Stripe's invalid_request_error for canceling a
 * subscription that is already canceled ("This subscription can't be
 * canceled because it's already canceled."). Matching /canceled/i on any
 * message was dangerous — a transport-level "request was canceled" (aborted
 * fetch, client timeout) would read as cancel-success and the subscription
 * would never actually be canceled.
 */
function isStripeAlreadyCanceled(err: unknown): boolean {
  const e = err as { code?: string; type?: string; rawType?: string; message?: string };
  if (e.code === 'resource_missing') return true;
  const isInvalidRequest =
    e.type === 'StripeInvalidRequestError' || e.rawType === 'invalid_request_error';
  return isInvalidRequest && /already canceled/i.test(e.message ?? '');
}

async function deleteAuth0Users(record: OrgDeletionRecord): Promise<void> {
  for (const member of record.members) {
    if (member.sub) await deleteAuth0User(member.sub);
  }
}

/** Drop every S3 Vectors index for the org's buckets and purge RAG rows. */
async function purgeRagData(orgId: string): Promise<void> {
  const vectorStore = new S3VectorsStore(Resource.RagVectorBucket.name);
  // Both prefixes in ONE paged scan — the table is scanned once, not per prefix.
  const keys = await scanRagKeys(orgId);
  const droppedIndexes = new Set<string>();

  for (const key of keys) {
    if (droppedIndexes.has(key.pk)) continue;
    droppedIndexes.add(key.pk);
    // INDEXER_CHECKPOINT# pks parse to undefined and are skipped inside.
    await dropVectorIndexForPk(vectorStore, key.pk);
  }
  await batchDelete(Resource.RagIndexerTable.name, keys);
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
  // A tenant setup racing the confirm may have provisioned after the concurrent
  // region teardown ran. Re-check before the profile row (the only pointer to
  // the tenant ids) is purged, and snapshot the live ids first so a crash still
  // leaves every tenant findable. The `deleting` flag written at confirm time
  // blocks new setups, so this converges.
  const lateRegions = await getRegionsWithTenantIdsForOrg(orgId);
  if (lateRegions.length > 0) {
    await snapshotTenantIdsOnDeletionRecord(orgId, record, lateRegions);
    for (const { orchestrator, tenantId } of lateRegions) {
      await orchestrator.deleteTenant(tenantId);
    }
  }

  // The RAGKEYHASH# lookup rows live OUTSIDE the org partition and are only
  // findable through the RAGKEY# rows — delete them first, while those rows
  // still point at them.
  await purgeRagKeyHashRows(orgId);

  // The ACCESSKEY# rows go with the rest of the partition: their upstream keys
  // died with the tenant, so no per-key orchestrator revocation is needed.
  const orgRows = await queryOrgRows(orgId);
  const orgKeys = orgRows
    .filter((row) => row.sk !== DeletionKeys.deletionSk())
    .map((row) => ({ pk: row.pk as string, sk: row.sk as string }));
  for (const key of orgKeys) assertPurgeablePk(key.pk, PURGEABLE_USER_INFO_PK_PREFIXES);
  await batchDelete(Resource.UserInfoTable.name, orgKeys);

  for (const member of record.members) {
    const userKey = { pk: `USER#${member.userId}`, sk: 'PROFILE' };
    assertPurgeablePk(userKey.pk, PURGEABLE_USER_INFO_PK_PREFIXES);
    await dynamo.send(
      new DeleteItemCommand({ TableName: Resource.UserInfoTable.name, Key: marshall(userKey) }),
    );

    // The SUB# identity row is kept forever as a tombstone (deleted/deletedAt
    // only) so a stale-but-valid session can never resurrect the account —
    // strip the PII-adjacent attributes instead of deleting the row.
    if (member.sub) {
      assertPurgeablePk(`SUB#${member.sub}`, PURGEABLE_USER_INFO_PK_PREFIXES);
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
    assertPurgeablePk(billingKey.pk, PURGEABLE_BILLING_PK_PREFIXES);
    await dynamo.send(
      new DeleteItemCommand({ TableName: Resource.BillingTable.name, Key: marshall(billingKey) }),
    );
  }

  await deleteDeletionChallenge(orgId);
}

/**
 * Deletes the org's tenant and its secrets in every region. Idempotent —
 * already-deleted tenants are success — so re-runs after a crash converge.
 */
async function deleteAllRegions(orgId: string, record: OrgDeletionRecord): Promise<void> {
  for (const { orchestrator, tenantId } of await resolveRegionTargets(orgId, record)) {
    await orchestrator.deleteTenant(tenantId);
  }
}

/**
 * Regions to tear down: prefer the live profile (it may know tenants
 * provisioned after the snapshot), falling back to the DELETION-record
 * `tenantIds` snapshot once the profile row is purged. Resolution is raw
 * (`getRegionsWithTenantIds`), not readiness-gated: a tenant whose setup is
 * still mid-flight exists upstream and must be deleted too, or its remote
 * resources and SSM secrets leak forever.
 */
async function resolveRegionTargets(
  orgId: string,
  record: OrgDeletionRecord,
): Promise<ProvisionedRegion[]> {
  const profile = await getOrgProfile(orgId);
  if (profile) return getRegionsWithTenantIds(profile);

  const snapshot = record.tenantIds ?? {};
  return getAvailableOrchestrators()
    .map((orchestrator) => {
      const tenantId = snapshot[orchestrator.id];
      return tenantId ? { orchestrator, tenantId } : null;
    })
    .filter((t): t is ProvisionedRegion => t !== null);
}

/**
 * Persist the live orchestrator-id → tenant-id map onto the DELETION record
 * (merged over the confirm-time snapshot) so tenants provisioned after the
 * confirm stay findable once the profile row is purged.
 */
async function snapshotTenantIdsOnDeletionRecord(
  orgId: string,
  record: OrgDeletionRecord,
  regions: ProvisionedRegion[],
): Promise<void> {
  const tenantIds: Record<string, string> = {
    ...(record.tenantIds ?? {}),
    ...Object.fromEntries(regions.map(({ orchestrator, tenantId }) => [orchestrator.id, tenantId])),
  };
  await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: DeletionKeys.deletionPk(orgId), sk: DeletionKeys.deletionSk() }),
      UpdateExpression: 'SET tenantIds = :tenantIds, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: marshall({
        ':tenantIds': tenantIds,
        ':now': new Date().toISOString(),
      }),
    }),
  );
  // Keep the in-memory record in step for the deleteAllRegions fallback.
  record.tenantIds = tenantIds;
}

/**
 * Terminal status write. Members are kept intact on the audit record: the
 * SUB# identity tombstone retains each sub forever anyway (see purgeRecords),
 * so stripping them here bought no privacy and broke audit correlation.
 */
async function markDone(orgId: string): Promise<void> {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: DeletionKeys.deletionPk(orgId), sk: DeletionKeys.deletionSk() }),
      UpdateExpression: 'SET #s = :done, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: marshall({
        ':done': OrgDeletionStatus.Done,
        ':now': new Date().toISOString(),
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Record + Dynamo helpers
// ---------------------------------------------------------------------------

/**
 * Per-pass liveness bump: `updatedAt` is touched alongside the attempt count
 * because the orchestrator treats a stale `updatedAt` as "worker died — re-
 * drive"; a live worker mid-teardown must never look stale to it.
 */
async function bumpAttemptCount(orgId: string): Promise<void> {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: DeletionKeys.deletionPk(orgId), sk: DeletionKeys.deletionSk() }),
      UpdateExpression: 'SET updatedAt = :now ADD attemptCount :one',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: marshall({ ':one': 1, ':now': new Date().toISOString() }),
    }),
  );
}

/**
 * RAG API keys write a `RAGKEYHASH#{sha256}/LOOKUP` row alongside the org's
 * `RAGKEY#` row (see lib/rag-api-keys.ts). The ORG# partition purge removes
 * the RAGKEY# rows but not the hash lookups — credential-hash residue that
 * would survive an erasure request forever — so derive each lookup pk from
 * the RAGKEY# rows' stored `tokenHash` and delete them explicitly.
 */
async function purgeRagKeyHashRows(orgId: string): Promise<void> {
  const ragKeyRows = await queryOrgRows(orgId, RagApiKeyKeys.orgSkPrefix());
  const lookupKeys = ragKeyRows
    .map((row) => row.tokenHash)
    .filter((tokenHash): tokenHash is string => typeof tokenHash === 'string')
    .map((tokenHash) => ({ pk: RagApiKeyKeys.lookupPk(tokenHash), sk: RagApiKeyKeys.lookupSk() }));
  for (const key of lookupKeys) assertPurgeablePk(key.pk, PURGEABLE_USER_INFO_PK_PREFIXES);
  await batchDelete(Resource.UserInfoTable.name, lookupKeys);
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

/** One paged full-table Scan matching BOTH of the org's RAG pk prefixes. */
async function scanRagKeys(orgId: string): Promise<{ pk: string; sk: string }[]> {
  const keys: { pk: string; sk: string }[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: Resource.RagIndexerTable.name,
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
// retry / orchestrator re-drives the idempotent purge later).
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
