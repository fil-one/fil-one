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
import { readDeletionRecord } from './deletion-record.js';
import {
  DeletionKeys,
  OrgDeletionStatus,
  RAGKeys,
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

const dynamo = getDynamoClient();

/**
 * Partition-key prefixes the purge is allowed to delete, per table. Anything
 * outside them — e.g. `EMAIL_NORM#`, the FIL-422 trial-claim record that must
 * survive account deletion — is structurally undeletable: the guard throws
 * before a delete is issued. The trailing `#` matters: it stops a prefix
 * colliding with a longer key family (`ORG#` never matches `ORGANIZATION#`).
 */
export const USER_INFO_PURGE_ALLOWLIST = ['ORG#', 'USER#', 'SUB#', 'RAGKEYHASH#'] as const;
export const BILLING_PURGE_ALLOWLIST = ['CUSTOMER#', 'DELETION_CHALLENGE#'] as const;

/** Blast-radius guard: refuses any purge target whose pk is outside the allowlist. */
export function assertPurgeTargetAllowed(pk: string, allowlist: readonly string[]): void {
  if (!allowlist.some((prefix) => pk.startsWith(prefix))) {
    throw new Error(`Refusing to purge key outside the allowlist: ${pk}`);
  }
}

/**
 * Run (or resume) the teardown for an org whose deletion was confirmed.
 * Driven by the ORG#{orgId}/DELETION record written by the delete-account
 * handler. There is no per-step state machine: every external teardown is
 * idempotent and snapshot-driven, so each invocation simply runs ALL of them
 * concurrently, then purges the DDB records and marks the record DONE. A
 * failure anywhere leaves the record non-DONE and throws after everything
 * settles, so Lambda's async retry / the reconciler cron re-drives the whole
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

  // The Stripe CUSTOMER object is kept (finance/audit needs the reference),
  // but its PII is erased via a Redaction Job; this PII-free tombstone
  // preserves the customer id across the purge.
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

  await redactStripeCustomer(orgId, record);
}

function isStripeAlreadyCanceled(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === 'resource_missing' || /canceled/i.test(e.message ?? '');
}

// ---------------------------------------------------------------------------
// Stripe customer redaction (docs.stripe.com/privacy/redaction)
// ---------------------------------------------------------------------------

interface StripeRedactionJob {
  id: string;
  /** created | validating | ready | redacting | succeeded | failed | canceling | canceled */
  status?: string;
}

/**
 * Redact the canceled customer's PII via Stripe's Redaction Jobs API. The
 * pinned SDK (22.0.2) has no `privacy.redactionJobs` namespace, so the REST
 * endpoints are driven through `stripe.rawRequest`.
 *
 * Job lifecycle: created → (validate) → validating → ready → (run) →
 * redacting → succeeded. Validation is asynchronous, so a single pass may
 * find the job short of `ready`; the job id is persisted on the DELETION
 * record at creation, and a not-yet-ready job throws so the record stays
 * non-DONE and the Lambda retry / reconciler advances the SAME job (never a
 * duplicate) on the next pass. `redacting`/`succeeded` count as done —
 * redaction is irreversible once running.
 */
async function redactStripeCustomer(orgId: string, record: OrgDeletionRecord): Promise<void> {
  const customerId = record.stripeCustomerId;
  if (!customerId) return;

  let jobId = record.stripeRedactionJobId;
  if (!jobId) {
    let created: StripeRedactionJob;
    try {
      created = await stripeRawRequest<StripeRedactionJob>('POST', '/v1/privacy/redaction_jobs', {
        objects: { customers: [customerId] },
      });
    } catch (err) {
      if (isRedactionUnnecessary(err)) {
        console.warn('[account-deletion] Stripe customer already redacted/missing', {
          orgId,
          customerId,
        });
        return;
      }
      throw err;
    }
    jobId = created.id;
    await persistRedactionJobId(orgId, jobId);
    record.stripeRedactionJobId = jobId;
    await stripeRawRequest('POST', `/v1/privacy/redaction_jobs/${jobId}/validate`);
  }

  await advanceRedactionJob(orgId, jobId);
}

/** GET the job's current status and take the one legal step toward `succeeded`. */
async function advanceRedactionJob(orgId: string, jobId: string): Promise<void> {
  const job = await stripeRawRequest<StripeRedactionJob>(
    'GET',
    `/v1/privacy/redaction_jobs/${jobId}`,
  );
  switch (job.status) {
    case 'succeeded':
    case 'redacting':
      // Running or already complete — irreversible, nothing left to drive.
      return;
    case 'ready':
      await stripeRawRequest('POST', `/v1/privacy/redaction_jobs/${jobId}/run`);
      return;
    case 'created':
      await stripeRawRequest('POST', `/v1/privacy/redaction_jobs/${jobId}/validate`);
      throw redactionNotReadyError(orgId, jobId, job.status);
    case 'validating':
      throw redactionNotReadyError(orgId, jobId, job.status);
    default:
      // failed / canceled / unknown: keep the record non-DONE so the stuck
      // gauge surfaces it — a failed validation needs operator attention.
      throw new Error(
        `Stripe redaction job ${jobId} for org ${orgId} is in unexpected status "${job.status}"`,
      );
  }
}

function redactionNotReadyError(orgId: string, jobId: string, status: string): Error {
  return new Error(
    `Stripe redaction job ${jobId} for org ${orgId} is not ready yet (status "${status}"); ` +
      'the next teardown pass advances it',
  );
}

async function persistRedactionJobId(orgId: string, jobId: string): Promise<void> {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: DeletionKeys.deletionPk(orgId), sk: DeletionKeys.deletionSk() }),
      UpdateExpression: 'SET stripeRedactionJobId = :jobId, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: marshall({
        ':jobId': jobId,
        ':now': new Date().toISOString(),
      }),
    }),
  );
}

async function stripeRawRequest<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return (await getStripeClient().rawRequest(method, path, params)) as T;
}

/** A missing or already-redacted customer means there is nothing to redact. */
function isRedactionUnnecessary(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === 'resource_missing' || /already.{0,20}redact/i.test(e.message ?? '');
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
  // A tenant setup racing the confirm may have provisioned after the
  // concurrent region teardown ran. Re-check before the profile row (the only
  // pointer to the tenant ids) is purged, persist the live tenant ids onto
  // the DELETION record so a crash still leaves every tenant findable, and
  // tear the stragglers down. The `deleting` flag written at confirm time
  // blocks new setups, so this converges. Raw tenant-id resolution (not
  // readiness-gated): a half-provisioned straggler must be torn down too.
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

  // UserInfoTable: everything under ORG#{orgId} except the DELETION record.
  // This includes the ACCESSKEY# rows — their upstream keys died with the
  // tenant (deleteTenant), so no per-key orchestrator revocation is needed.
  const orgRows = await queryOrgRows(orgId);
  const orgKeys = orgRows
    .filter((row) => row.sk !== DeletionKeys.deletionSk())
    .map((row) => ({ pk: row.pk as string, sk: row.sk as string }));
  for (const key of orgKeys) assertPurgeTargetAllowed(key.pk, USER_INFO_PURGE_ALLOWLIST);
  await batchDelete(Resource.UserInfoTable.name, orgKeys);

  for (const member of record.members) {
    const userKey = { pk: `USER#${member.userId}`, sk: 'PROFILE' };
    assertPurgeTargetAllowed(userKey.pk, USER_INFO_PURGE_ALLOWLIST);
    await dynamo.send(
      new DeleteItemCommand({ TableName: Resource.UserInfoTable.name, Key: marshall(userKey) }),
    );

    // The SUB# identity row is kept forever as a tombstone (deleted/deletedAt
    // only) so a stale-but-valid session can never resurrect the account —
    // strip the PII-adjacent attributes instead of deleting the row.
    if (member.sub) {
      assertPurgeTargetAllowed(`SUB#${member.sub}`, USER_INFO_PURGE_ALLOWLIST);
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
    assertPurgeTargetAllowed(billingKey.pk, BILLING_PURGE_ALLOWLIST);
    await dynamo.send(
      new DeleteItemCommand({ TableName: Resource.BillingTable.name, Key: marshall(billingKey) }),
    );
  }

  await deleteDeletionChallenge(orgId);
}

/**
 * Deletes the org's tenant (and its secrets) in every region via each
 * orchestrator's `deleteTenant`. Idempotent — already-deleted tenants are
 * success — so re-runs after a crash converge.
 */
async function deleteAllRegions(orgId: string, record: OrgDeletionRecord): Promise<void> {
  for (const { orchestrator, tenantId } of await resolveRegionTargets(orgId, record)) {
    await orchestrator.deleteTenant(tenantId);
  }
}

/**
 * Regions to tear down: prefer the live profile (it may know tenants
 * provisioned after the snapshot); when the profile row is already purged,
 * fall back to the DELETION-record snapshot — the region-generic `tenantIds`
 * map, plus the legacy per-orchestrator fields for in-flight records.
 * Resolution is raw (`getRegionsWithTenantIds`), not readiness-gated: a
 * tenant whose setup is still mid-flight exists upstream and must be
 * deleted too, or its remote resources and SSM secrets leak forever.
 */
async function resolveRegionTargets(
  orgId: string,
  record: OrgDeletionRecord,
): Promise<ProvisionedRegion[]> {
  const profile = await getOrgProfile(orgId);
  if (profile) return getRegionsWithTenantIds(profile);

  const snapshot: Record<string, string> = {
    ...(record.auroraTenantId ? { aurora: record.auroraTenantId } : {}),
    ...(record.fthTenantId ? { fth: record.fthTenantId } : {}),
    ...(record.tenantIds ?? {}),
  };
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
    ...(record.auroraTenantId ? { aurora: record.auroraTenantId } : {}),
    ...(record.fthTenantId ? { fth: record.fthTenantId } : {}),
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
  for (const key of lookupKeys) assertPurgeTargetAllowed(key.pk, USER_INFO_PURGE_ALLOWLIST);
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
