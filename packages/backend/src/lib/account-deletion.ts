import {
  BatchWriteItemCommand,
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
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
import { discoverBillingCustomer } from './billing-customer-discovery.js';
import { getDynamoClient } from './ddb-client.js';
import { deleteDeletionChallenge } from './deletion-challenge.js';
import { applyDeletionGuards } from './deletion-guards.js';
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
import { settleAll } from './settle-all.js';
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
// `ORG#` covers the usage-reporting worker's BillingTable `ORG#{orgId}` /
// `USAGE_REPORT#{date}` audit rows. They were previously outside this list, so
// nothing purged them and they survived a completed deletion until their
// 365-day TTL. The trailing `#` keeps this away from `ORG_TOMBSTONE#`, the
// PII-free customer reference that must OUTLIVE the purge.
export const PURGEABLE_BILLING_PK_PREFIXES = ['CUSTOMER#', 'DELETION_CHALLENGE#', 'ORG#'] as const;

/** Blast-radius guard: refuses any purge target outside the purgeable prefixes. */
export function assertPurgeablePk(pk: string, prefixes: readonly string[]): void {
  if (!prefixes.some((prefix) => pk.startsWith(prefix))) {
    throw new Error(`Refusing to purge key outside the purgeable prefixes: ${pk}`);
  }
}

/**
 * Stripe Search indexes writes with a lag (~25s, measured 2026-08-07). A
 * customer minted inside the deletion race is therefore invisible to discovery
 * until this long after IT WAS CREATED — which is why the wait below is
 * anchored on `purgedAt` (the instant minting became impossible) and not on
 * `requestedAt`. Anchoring on the request only bounds the mint that happens at
 * the very instant of the request: on a large org whose pass runs for minutes,
 * an in-flight request that beat the fence can mint a customer near the END of
 * the pass, long after a requestedAt-based margin has "elapsed", and the
 * discovery that follows is then still inside the lag.
 */
const STRIPE_SEARCH_LAG_MARGIN_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Block until {@link STRIPE_SEARCH_LAG_MARGIN_MS} has passed since the purge
 * completed, so the post-purge discovery pass can see a customer minted in the
 * deletion race and `markDone` cannot make the record inert with that
 * customer's PII still in Stripe.
 *
 * Waited out IN-PASS rather than thrown as a retry: this is the ordinary
 * ending of a HEALTHY teardown, and a throw would emit a Lambda `Errors`
 * datapoint (what Grafana alerts on), burn an async retry, inflate
 * `attemptCount` toward the reconciler's stuck threshold, refresh the staleness
 * window, and re-run every external teardown and the whole purge a second time.
 *
 * The anchor is stamped as the LAST step of the purge and read back in the same
 * pass, so a FIRST pass always waits the full margin — every healthy deletion,
 * whatever the org's size. Purge duration cannot count against the wait,
 * because the anchor is set after the purge, not before it. Only a re-drive
 * (whose stored `purgedAt` is already old) waits less, and a legacy/corrupt one
 * waits zero. The margin is therefore ADDITIVE to the pass: headroom against
 * the 900s Lambda budget is 900s - 60s. Convergence is unaffected either way —
 * a first pass killed at the 900s timeout re-drives with `purgedAt` already
 * stored, and that pass waits zero.
 *
 * A missing or unparseable `purgedAt` is treated as "old enough" rather than
 * hard-failing: legacy DELETION records predate this field (see
 * dynamo-records.ts), and wedging their teardown forever is strictly worse than
 * running a discovery pass that may be early.
 */
async function waitOutStripeSearchLag(orgId: string, record: OrgDeletionRecord): Promise<void> {
  const purgedAtMs = Date.parse(record.purgedAt ?? '');
  if (Number.isNaN(purgedAtMs)) {
    console.warn(
      '[account-deletion] DELETION record carries no usable purgedAt; treating the Stripe ' +
        'search-index lag as already elapsed',
      { orgId, purgedAt: record.purgedAt },
    );
    return;
  }
  const elapsedMs = Date.now() - purgedAtMs;
  if (elapsedMs >= STRIPE_SEARCH_LAG_MARGIN_MS) return;
  // Clamped to the margin: a `purgedAt` in the future (clock skew between the
  // Lambda that stamped it and this one) must never park the pass for longer
  // than the wait it is standing in for.
  const remainingMs = Math.min(
    STRIPE_SEARCH_LAG_MARGIN_MS - elapsedMs,
    STRIPE_SEARCH_LAG_MARGIN_MS,
  );
  console.warn(
    "[account-deletion] Waiting out Stripe's search-index lag before the post-purge discovery pass",
    { orgId, remainingMs, clockSkewed: elapsedMs < 0 },
  );
  await sleep(remainingMs);
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
 * One pass is therefore: bump the attempt count, re-apply the fences, settle
 * all four external teardowns, purge the DDB records and stamp `purgedAt`,
 * wait out Stripe's search-index lag — the full 60s margin on a first pass,
 * since `purgedAt` was stamped moments earlier; only a re-drive finds it
 * already elapsed — run Stripe discovery a SECOND time, then mark DONE. Stripe runs
 * twice because its customer discovery is index-lagged; see the second call
 * site below. The in-pass wait is deliberate — deferring to a retry instead
 * would double every external teardown and the whole purge; see
 * {@link waitOutStripeSearchLag}.
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
  let firstPassCustomerId: string | undefined;
  const externals: { name: string; run: () => Promise<void> }[] = [
    { name: 'regions', run: () => deleteAllRegions(orgId, record) },
    {
      name: 'stripe',
      run: async () => {
        firstPassCustomerId = await cancelStripeAndWriteTombstone(orgId, record);
      },
    },
    { name: 'auth0', run: () => deleteAuth0Users(record) },
    { name: 'rag', run: () => purgeRagData(orgId) },
  ];
  await settleAll(externals, (names) => `Account teardown failed for org ${orgId} in: ${names}`);

  await purgeRecords(orgId, record);

  // Second Stripe pass — NOT redundant. Stripe Search indexes writes with a lag
  // (~25s, measured 2026-08-07), so the first pass is blind to a customer minted
  // in the deletion race. What makes this pass able to see what the first could
  // not is the wait below, NOT the elapsed teardown work: a small org finishes
  // well inside the lag window. Do NOT drop this pass because the first
  // "usually" finds everything — the case it misses is the unredacted-PII bug
  // this design exists to close.
  await waitOutStripeSearchLag(orgId, record);
  await cancelStripeAndWriteTombstone(orgId, record, { customerId: firstPassCustomerId });

  await markDone(orgId);
  console.warn('[account-deletion] Teardown complete', { orgId });
}

// ---------------------------------------------------------------------------
// External teardowns — each idempotent
// ---------------------------------------------------------------------------

/**
 * Cancel the org's Stripe billing, tombstone the customer reference and queue
 * its PII redaction. The customer is discovered LIVE from Stripe metadata
 * rather than read off the DELETION record: a confirm-time snapshot cannot see
 * a customer minted inside the deletion race windows, and that customer's PII
 * would then survive in Stripe forever (see billing-customer-discovery.ts).
 *
 * Idempotent, and run twice per teardown.
 *
 * @param prior the first pass's discovery result. Present ONLY on the second
 *   pass, where it marks a newly-visible customer as a late (race-window) find
 *   worth shouting about.
 * @returns the discovered customer id, if any.
 */
async function cancelStripeAndWriteTombstone(
  orgId: string,
  record: OrgDeletionRecord,
  prior?: { customerId?: string },
): Promise<string | undefined> {
  const { customerId, extraCustomerIds } = await discoverBillingCustomer(orgId, record.members);
  const allCustomerIds = customerId ? [customerId, ...extraCustomerIds] : extraCustomerIds;

  if (prior && customerId && customerId !== prior.customerId) {
    console.warn(
      '[account-deletion] Late Stripe customer discovered after purge — a trial/customer was ' +
        'minted inside the deletion race window',
      { orgId, customerId },
    );
  }

  // EVERY discovered customer is swept, extras included: even in the anomalous
  // multi-customer case billing must stop.
  await cancelAllSubscriptions(orgId, allCustomerIds);

  // The org ↔ customer relationship is 1:1 by domain, so the tombstone and the
  // redaction job are single-customer. Extras mean that invariant broke: stop
  // here rather than silently pick one to redact and strand the others'
  // PII. The record stays non-DONE, so the orchestrator re-drives it and the
  // stuck gauge surfaces it for manual redaction.
  if (extraCustomerIds.length > 0) {
    throw new Error(
      `multiple Stripe customers discovered for org ${orgId} (${allCustomerIds.join(', ')}); ` +
        'single-customer teardown cannot redact them all — manual follow-up required',
    );
  }

  await writeTombstone(orgId, customerId);
  await redactStripeCustomers(orgId, record, customerId);
  return customerId;
}

/** Cancel every live subscription of every given customer; already-gone is success. */
async function cancelAllSubscriptions(orgId: string, customerIds: string[]): Promise<void> {
  for (const customerId of customerIds) {
    for (const subscriptionId of await cancellableSubscriptionIds(orgId, customerId)) {
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
}

/**
 * The Stripe CUSTOMER object is kept (finance/audit needs the reference) while
 * its PII is erased via a Redaction Job, so this PII-free tombstone preserves
 * the customer id across the purge.
 *
 * A tombstone already naming a DIFFERENT customer is never silently
 * overwritten: that would strand the previously-recorded customer with no
 * pointer left to redact it by. Throwing keeps the record non-DONE for the
 * re-drive / manual follow-up. A pass that discovers nothing leaves an
 * existing id in place rather than erasing it.
 *
 * The read below is only a snapshot — {@link tombstoneCondition} is what
 * actually holds that invariant against two overlapping workers (whose
 * discovery calls can straddle the Stripe index lag and so disagree). Losing
 * that race is only an error when the two passes genuinely disagree: a pass
 * that discovered nothing accepts the winner's tombstone (see the catch).
 */
async function writeTombstone(orgId: string, customerId: string | undefined): Promise<void> {
  const key = { pk: DeletionKeys.tombstonePk(orgId), sk: DeletionKeys.tombstoneSk() };
  const current = await readTombstone(key);
  if (current?.stripeCustomerId && customerId && current.stripeCustomerId !== customerId) {
    throw new Error(
      `Org ${orgId} tombstone already records Stripe customer ${current.stripeCustomerId} but ` +
        `discovery found ${customerId}; refusing to overwrite — manual follow-up required`,
    );
  }

  const recordedCustomerId = customerId ?? current?.stripeCustomerId;
  // Already exactly right — skip the write rather than re-stamping `deletedAt`
  // on every pass. That field is the audit answer to "when was this org
  // deleted?", so it must keep naming the first pass, not the last.
  if (current && current.stripeCustomerId === recordedCustomerId) return;

  const tombstone: OrgTombstoneRecord = {
    ...key,
    orgId,
    ...(recordedCustomerId ? { stripeCustomerId: recordedCustomerId } : {}),
    deletedAt: current?.deletedAt ?? new Date().toISOString(),
  };
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: Resource.BillingTable.name,
        Item: marshall(tombstone),
        ...tombstoneCondition(recordedCustomerId),
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    // A pass that discovered NOTHING had nothing to write, so an overlapping
    // worker that landed a customer id first has strictly the better tombstone:
    // accept it instead of failing this whole pass over a benign upgrade. Only
    // a genuine disagreement (or a still-id-less tombstone, which means the
    // condition failed for a reason we do not understand) is fatal.
    if (recordedCustomerId === undefined && (await readTombstone(key))?.stripeCustomerId) return;
    throw new Error(
      `Org ${orgId} tombstone was written concurrently while this pass was recording Stripe ` +
        `customer ${recordedCustomerId ?? '(none discovered)'}; refusing to overwrite — ` +
        'the next teardown pass re-reads it',
    );
  }
}

/** Strongly-consistent read of the org's tombstone; absent reads as undefined. */
async function readTombstone(key: {
  pk: string;
  sk: string;
}): Promise<OrgTombstoneRecord | undefined> {
  const existing = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.BillingTable.name,
      Key: marshall(key),
      ConsistentRead: true,
    }),
  );
  return existing.Item ? (unmarshall(existing.Item) as OrgTombstoneRecord) : undefined;
}

/**
 * The tombstone's write condition. A tombstone that names a customer may never
 * be replaced — neither by one naming a different customer nor by one naming
 * none at all, which is the case the check-then-write above cannot see and
 * which would destroy the last pointer to redact by. Upgrading a tombstone that
 * names NO customer to one that does is allowed: that is the post-purge pass
 * recording a late (race-window) find, and it strands nothing.
 */
function tombstoneCondition(recordedCustomerId: string | undefined) {
  const noNamedCustomer = 'attribute_not_exists(pk) OR attribute_not_exists(stripeCustomerId)';
  if (!recordedCustomerId) return { ConditionExpression: noNamedCustomer };
  return {
    ConditionExpression: `${noNamedCustomer} OR stripeCustomerId = :id`,
    ExpressionAttributeValues: marshall({ ':id': recordedCustomerId }),
  };
}

/** Stripe statuses a subscription can never leave — nothing left to cancel. */
const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'canceled',
  'incomplete_expired',
]);

/**
 * Asks Stripe for the customer's live subscriptions: one created during the
 * deletion race window (see handlers/activate-subscription.ts) would otherwise
 * bill a deleted account forever. A `resource_missing` means the customer
 * itself is gone (the customer.deleted trigger), and Stripe already cancelled
 * its subscriptions.
 */
async function cancellableSubscriptionIds(orgId: string, customerId: string): Promise<string[]> {
  const ids: string[] = [];
  try {
    for await (const subscription of getStripeClient().subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100,
    })) {
      if (!TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)) ids.push(subscription.id);
    }
  } catch (err) {
    if ((err as { code?: string }).code !== 'resource_missing') throw err;
    console.warn('[account-deletion] Stripe customer already deleted; nothing to cancel', {
      orgId,
      stripeCustomerId: customerId,
    });
  }
  return ids;
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
    await deleteTenantsInRegions(orgId, lateRegions, 'Late-region');
  }

  // ONE SNAPSHOT drives both deletes below, and that — not the order — is what
  // removes the orphan window. The RAGKEYHASH# lookup rows live OUTSIDE the org
  // partition and are findable only through the RAGKEY# rows' `tokenHash`, so
  // two separate queries left a hole: a create-rag-api-key transaction
  // committing between them wrote a RAGKEY# row the partition delete then swept
  // while its lookup row, never seen by the earlier sweep, survived forever.
  // Sharing the snapshot closes that: every RAGKEY# row this pass deletes has
  // its lookup deleted too, and a key created after the snapshot keeps BOTH
  // rows (never a half pair) for the fence and the reconciler to handle.
  const orgRows = await queryOrgRows(orgId);

  // Given one snapshot, the order is chosen for CRASH-CONVERGENCE. `batchDelete`
  // throws once its retries are exhausted on UnprocessedItems — most likely on
  // the largest orgs — and the 900s teardown is expected to be interrupted and
  // resume on a later pass (see the timeout note in sst.config.ts). A re-drive
  // re-queries the partition, so anything deleted from it is no longer a pointer
  // to anything else. Hashes therefore go FIRST: a crash mid-purge leaves a
  // RAGKEY# row with no lookup — an unusable key, swept next pass — instead of
  // a credential hash no later pass could ever find again. (The reverse order
  // would strand it forever, which is exactly what purgeRagKeyHashRows exists to
  // prevent.) The window this leaves — a key created between the two deletes —
  // is already closed by fence B: PROFILE still exists here carrying
  // `deleting = true`, re-armed every pass by applyDeletionGuards, so
  // create-rag-api-key is refused outright.
  await purgeRagKeyHashRows(orgRows);

  // The ACCESSKEY# rows go with the rest of the partition: their upstream keys
  // died with the tenant, so no per-key orchestrator revocation is needed.
  const orgKeys = orgRows
    .filter((row) => row.sk !== DeletionKeys.deletionSk())
    .map((row) => ({ pk: row.pk as string, sk: row.sk as string }));
  for (const key of orgKeys) assertPurgeablePk(key.pk, PURGEABLE_USER_INFO_PK_PREFIXES);
  await batchDelete(Resource.UserInfoTable.name, orgKeys);

  // BillingTable `ORG#{orgId}` — the usage-reporting worker's audit rows.
  await purgeBillingOrgRows(orgId);

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

  await stampPurgedAt(orgId, record);
}

/**
 * Record the instant the purge finished — the anchor
 * {@link waitOutStripeSearchLag} measures from, and the best available one: the
 * fences are re-applied at the top of every pass and the purge has just run, so
 * from here on every writer that CONSULTS the fence is refused. It is not an
 * absolute cutoff: a request that read the profile before the fence landed can
 * still mint a Stripe customer after this instant, bounded by API Gateway's 29s
 * request timeout. A 60s margin against a ~25s index lag leaves ~35s of slack,
 * which covers that tail today — but the slack is what makes it hold, so the
 * margin cannot be cut toward the lag without re-opening the gap.
 * `requestedAt` is a far worse anchor: a request that beat the fence can mint
 * at any point up to here.
 *
 * `if_not_exists` keeps the EARLIEST purge across passes: the fences were
 * already up then, so a re-drive must not restart the wait. Persisted (rather
 * than kept in memory) for exactly that reason.
 */
async function stampPurgedAt(orgId: string, record: OrgDeletionRecord): Promise<void> {
  const purgedAt = record.purgedAt ?? new Date().toISOString();
  await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: DeletionKeys.deletionPk(orgId), sk: DeletionKeys.deletionSk() }),
      UpdateExpression: 'SET purgedAt = if_not_exists(purgedAt, :purgedAt), updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: marshall({
        ':purgedAt': purgedAt,
        ':now': new Date().toISOString(),
      }),
    }),
  );
  // Keep the in-memory record in step for the wait below. A concurrent worker
  // that stamped first wins in DynamoDB; using our own (later) value here only
  // ever waits longer, never less.
  record.purgedAt = purgedAt;
}

/**
 * Deletes the org's tenant and its secrets in every region. Idempotent —
 * already-deleted tenants are success — so re-runs after a crash converge.
 */
async function deleteAllRegions(orgId: string, record: OrgDeletionRecord): Promise<void> {
  await deleteTenantsInRegions(orgId, await resolveRegionTargets(orgId, record), 'Region');
}

/**
 * Tear down a set of regional tenants, attempting EVERY one before the group
 * fails, matching how {@link runAccountDeletion} treats its external teardowns.
 * A sequential loop let one region's throw skip all the rest, and an
 * orchestrator that throws whenever it cannot confirm the tenant reached
 * DISABLED (Aurora) makes that an ordinary occurrence, not a rare one. Used by
 * both teardown sites — the main region sweep and the purge's late-region
 * re-check.
 */
async function deleteTenantsInRegions(
  orgId: string,
  targets: ProvisionedRegion[],
  phase: 'Region' | 'Late-region',
): Promise<void> {
  await settleAll(
    targets.map(({ orchestrator, tenantId }) => ({
      name: orchestrator.id,
      run: () => orchestrator.deleteTenant(tenantId),
    })),
    (names) => `${phase} teardown failed for org ${orgId} in: ${names}`,
  );
}

/**
 * Regions to tear down: prefer the live profile (it may know tenants
 * provisioned after the snapshot), falling back to the DELETION-record
 * `tenantIds` snapshot once the profile row is purged. Resolution is raw
 * (`getRegionsWithTenantIds`), not readiness-gated: a tenant whose setup is
 * still mid-flight exists upstream and must be deleted too, or its remote
 * resources and SSM secrets leak forever.
 *
 * The profile read is strongly consistent. Eventual consistency is safe for the
 * write-once tenant ids everywhere else (see org-profile.ts), but not here: a
 * stale read reports "no tenant in this region", the region is skipped, the
 * non-empty read short-circuits the snapshot fallback below, and the profile —
 * the only pointer to the tenant id — is then purged and the record marked
 * DONE, leaking a live upstream tenant we keep paying for.
 */
async function resolveRegionTargets(
  orgId: string,
  record: OrgDeletionRecord,
): Promise<ProvisionedRegion[]> {
  const profile = await getOrgProfile(orgId, { consistent: true });
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
 *
 * Takes the partition snapshot the caller already fetched rather than
 * re-querying: sharing one snapshot with the partition delete is what makes the
 * pairing exact, and running before it is what makes a crash between the two
 * recoverable (see the note at the call site).
 */
async function purgeRagKeyHashRows(orgRows: Record<string, unknown>[]): Promise<void> {
  const lookupKeys = orgRows
    .filter((row) => typeof row.sk === 'string' && row.sk.startsWith(RagApiKeyKeys.orgSkPrefix()))
    .map((row) => row.tokenHash)
    .filter((tokenHash): tokenHash is string => typeof tokenHash === 'string')
    .map((tokenHash) => ({ pk: RagApiKeyKeys.lookupPk(tokenHash), sk: RagApiKeyKeys.lookupSk() }));
  for (const key of lookupKeys) assertPurgeablePk(key.pk, PURGEABLE_USER_INFO_PK_PREFIXES);
  await batchDelete(Resource.UserInfoTable.name, lookupKeys);
}

/** The only sk the teardown claims from the BillingTable `ORG#` partition. */
const USAGE_REPORT_SK_PREFIX = 'USAGE_REPORT#';

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
async function purgeBillingOrgRows(orgId: string): Promise<void> {
  const rows = await queryPartition(
    Resource.BillingTable.name,
    `ORG#${orgId}`,
    USAGE_REPORT_SK_PREFIX,
  );
  const keys = rows.map((row) => ({ pk: row.pk as string, sk: row.sk as string }));
  for (const key of keys) assertPurgeablePk(key.pk, PURGEABLE_BILLING_PK_PREFIXES);
  await batchDelete(Resource.BillingTable.name, keys);
}

/** Paged Query of the org's UserInfoTable partition. */
async function queryOrgRows(orgId: string): Promise<Record<string, unknown>[]> {
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
