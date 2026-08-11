import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { readDeletionRecord } from './deletion-record.js';
import { DeletionKeys, type OrgDeletionRecord } from './dynamo-records.js';
import { getStripeClient } from './stripe-client.js';

// ---------------------------------------------------------------------------
// Stripe customer redaction (docs.stripe.com/privacy/redaction)
// ---------------------------------------------------------------------------

const dynamo = getDynamoClient();

interface StripeRedactionJob {
  id: string;
  /** created | validating | ready | redacting | succeeded | failed | canceling | canceled */
  status?: string;
  /** Objects the job redacts, as passed at creation. */
  objects?: { customers?: string[] };
}

interface StripeRedactionJobList {
  data?: StripeRedactionJob[];
  /** Stripe's cursor-pagination flag: more pages exist after this one. */
  has_more?: boolean;
}

/** Jobs per page of the redaction-job list; 100 is Stripe's maximum. */
const REDACTION_JOB_PAGE_SIZE = 100;

/**
 * Pages the redaction-job list will walk before giving up. Jobs are
 * account-wide and one is created per org deletion, so the list grows without
 * bound and the conflicting job can sit arbitrarily deep. This bounds the walk
 * (~10k jobs) rather than the search: past it we throw instead of concluding
 * "not found", because a silent not-found would report a live conflicting job
 * as absent.
 */
const REDACTION_JOB_MAX_PAGES = 100;

/**
 * Redact the canceled customers' PII via Stripe's Redaction Jobs API. The org
 * ↔ Stripe customer relationship is 1:1 by domain, so an ordinary teardown
 * passes exactly one id. The pinned SDK (22.0.2) has no `privacy.redactionJobs`
 * namespace, so the REST endpoints are driven through `stripe.rawRequest`.
 *
 * Job lifecycle: created → (validate) → validating → ready → (run) →
 * redacting → succeeded. Validation is asynchronous, so a single pass may find
 * the job short of `ready`; each job id is persisted on the DELETION record at
 * creation KEYED BY THE CUSTOMER IT COVERS, and a not-yet-ready job throws so
 * the record stays non-DONE and the Lambda retry / reconciler advances the SAME
 * job (never a duplicate) on the next pass. `redacting`/`succeeded` count as
 * done — redaction is irreversible once running.
 *
 * Every customer is ATTEMPTED before the group fails: a not-yet-ready job for
 * one customer throws by design, and letting that skip the next customer would
 * mean a permanently failed job on one customer blocks another's redaction
 * forever. Sequential, because the passes share the in-memory record. A lone
 * failure is rethrown as itself rather than wrapped — the "not ready yet" /
 * "unexpected status" messages ARE the operator signal.
 */
export async function redactStripeCustomers(
  orgId: string,
  record: OrgDeletionRecord,
  customerIds: readonly string[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const customerId of customerIds) {
    try {
      await redactStripeCustomer(orgId, record, customerId);
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `Stripe redaction failed for ${failures.length} of org ${orgId}'s customers`,
    );
  }
}

/**
 * Drive one customer's redaction to its next legal state.
 *
 * A stored job id is only usable for this customer if Stripe still has that job
 * and it actually COVERS them, and that is asked rather than assumed — a stored
 * job that has gone away would wedge the teardown forever, and one that covers
 * somebody else would let this customer's PII survive un-redacted. The job GET
 * that answers the question is the same one {@link advanceRedactionJob} needs,
 * so the common path still costs one call.
 *
 * A stored id proven unusable is REPLACED, not raced: `establishRedactionJob` is
 * told which id it is superseding so its write is a compare-and-swap on that
 * customer's slot. Without that the fresh job could never be persisted (the slot
 * is occupied), and the pass would go straight back to driving the unusable id.
 */
async function redactStripeCustomer(
  orgId: string,
  record: OrgDeletionRecord,
  customerId: string,
): Promise<void> {
  const stored = record.stripeRedactionJobIds?.[customerId];
  if (stored) {
    const job = await fetchRedactionJob(stored);
    if (job && (job.objects?.customers ?? []).includes(customerId)) {
      return advanceRedactionJob(orgId, job);
    }
    console.warn(
      '[stripe-redaction] Stored redaction job is gone or does not cover this customer; ' +
        'establishing one for it instead of skipping the redaction',
      { orgId, customerId, storedJobId: stored, jobFound: job !== undefined },
    );
  }

  const established = await establishRedactionJob(orgId, record, customerId, stored);
  if (!established) return; // customer missing — nothing to redact
  await advanceRedactionJob(orgId, await requireRedactionJob(established));
}

/**
 * Create the customer's redaction job and persist its id — or, when Stripe
 * reports the customer is already in another (live) redaction job, recover and
 * persist THAT job's id so its lifecycle gets driven instead of the redaction
 * being skipped. Returns `null` only when the customer no longer exists.
 *
 * @param replacing the stored job id this call has proven unusable, if any; the
 *   persist then swaps that exact id rather than requiring an empty slot.
 */
async function establishRedactionJob(
  orgId: string,
  record: OrgDeletionRecord,
  customerId: string,
  replacing?: string,
): Promise<string | null> {
  let created: StripeRedactionJob | undefined;
  try {
    created = await stripeRawRequest<StripeRedactionJob>('POST', '/v1/privacy/redaction_jobs', {
      objects: { customers: [customerId] },
    });
  } catch (err) {
    if (!isCustomerRedactable(err)) {
      console.warn('[stripe-redaction] Stripe customer already redacted/missing', {
        orgId,
        customerId,
      });
      return null;
    }
    if (!isRedactionJobConflict(err)) throw err;
    // The customer is already in another redaction job (e.g. a previous pass
    // created one but crashed before persisting its id). That job is NOT
    // complete — recover its id and drive ITS lifecycle instead of skipping
    // redaction, or the original job sits unvalidated forever.
    const recovered = await findRedactionJobIdForCustomer(orgId, customerId);
    return persistRedactionJobId({ orgId, record, customerId, jobId: recovered, replacing });
  }

  // Persist may lose against a concurrent worker — the stored id wins, and
  // only OUR freshly created job gets the initial validate kick (the stored
  // one's lifecycle is driven by advanceRedactionJob).
  const jobId = await persistRedactionJobId({
    orgId,
    record,
    customerId,
    jobId: created.id,
    replacing,
  });
  if (jobId === created.id) {
    await stripeRawRequest('POST', `/v1/privacy/redaction_jobs/${jobId}/validate`);
  }
  return jobId;
}

/**
 * Recover the id of the live redaction job that already contains the customer
 * (create returned a job-conflict). Terminal jobs (failed/canceled) are
 * skipped — they no longer block a new job, so they can't be the conflicting
 * one.
 *
 * Paged via Stripe's `has_more`/`starting_after` cursor. The SDK's
 * auto-paginating iterator is not available here: the pinned version has no
 * `privacy.redactionJobs` namespace, so this list goes through `rawRequest`.
 * A single unpaginated page silently stopped finding the conflicting job once
 * the account passed its page size, and every retry then threw — wedging that
 * teardown permanently.
 */
async function findRedactionJobIdForCustomer(orgId: string, customerId: string): Promise<string> {
  let startingAfter: string | undefined;
  for (let page = 0; page < REDACTION_JOB_MAX_PAGES; page++) {
    const jobs = await stripeRawRequest<StripeRedactionJobList>(
      'GET',
      '/v1/privacy/redaction_jobs',
      {
        limit: REDACTION_JOB_PAGE_SIZE,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      },
    );
    const data = jobs.data ?? [];
    const match = data.find(
      (job) =>
        job.status !== 'failed' &&
        job.status !== 'canceled' &&
        (job.objects?.customers ?? []).includes(customerId),
    );
    if (match) return match.id;
    if (!jobs.has_more || data.length === 0) {
      throw new Error(
        `Stripe reported customer ${customerId} (org ${orgId}) is already in a redaction job, but ` +
          'no live job containing them was found; the next teardown pass retries',
      );
    }
    startingAfter = data[data.length - 1].id;
  }
  // Never conclude "not found" from an exhausted walk: Stripe says a live job
  // contains this customer, so failing loudly is the only honest answer.
  throw new Error(
    `Stripe reported customer ${customerId} (org ${orgId}) is already in a redaction job, but it ` +
      `was not found within ${REDACTION_JOB_MAX_PAGES} pages of the redaction-job list; ` +
      'manual follow-up required',
  );
}

/**
 * GET a redaction job by id. A job Stripe no longer knows about reads as
 * `undefined` rather than throwing: the only caller is the stored-id coverage
 * check, for which "gone" and "does not cover this customer" have the same
 * answer — establish a fresh job.
 */
async function fetchRedactionJob(jobId: string): Promise<StripeRedactionJob | undefined> {
  try {
    return await requireRedactionJob(jobId);
  } catch (err) {
    if ((err as { code?: string }).code !== 'resource_missing') throw err;
    return undefined;
  }
}

/** GET a redaction job by id; a missing job is an error here. */
async function requireRedactionJob(jobId: string): Promise<StripeRedactionJob> {
  return stripeRawRequest<StripeRedactionJob>('GET', `/v1/privacy/redaction_jobs/${jobId}`);
}

/**
 * Take the one legal step toward `succeeded` for an already-fetched job.
 *
 * `redacting` counts as done, and that is what keeps a first teardown's discovery
 * working across passes: creating and validating a job does not null the customer's
 * metadata — only RUNNING it does — so a customer whose job is still short of
 * `ready` is re-found by the next pass's `metadata` search. Once the job is running
 * the metadata may be gone, but this returns without needing it. Only a resweep has
 * to carry customer ids forward explicitly, because its purge removes the rows the
 * sweep would otherwise re-derive them from.
 */
async function advanceRedactionJob(orgId: string, job: StripeRedactionJob): Promise<void> {
  const jobId = job.id;
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

/**
 * Persist the redaction job id under the customer it covers, as a
 * compare-and-swap on that customer's slot: either the slot is empty, or it
 * still holds exactly the id the caller proved unusable. Two overlapping workers
 * can each create/recover a job; an unconditional SET would let the loser
 * overwrite the winner and leave a duplicate redaction job driving nowhere. On a
 * conditional failure the stored id wins: it is re-read and returned so the
 * caller drives THAT job.
 *
 * @param replacing the id currently in the slot that this write supersedes. Only
 *   set by the coverage check; without it the write requires an empty slot.
 * @returns the effective job id — `jobId` when this write won, otherwise the
 *          id another worker persisted first.
 */
async function persistRedactionJobId(params: {
  orgId: string;
  record: OrgDeletionRecord;
  customerId: string;
  jobId: string;
  replacing?: string;
}): Promise<string> {
  const { orgId, record, customerId, jobId, replacing } = params;
  try {
    // A nested SET cannot address a path inside a map that does not exist yet,
    // so seed it first. Idempotent, and only reached when a job is established.
    // INSIDE the try: its `attribute_exists(pk)` fails the same way the write
    // below does when the DELETION record is gone, and outside it that surfaced
    // as a bare ConditionalCheckFailedException naming nothing.
    await seedMapAttribute(orgId, 'stripeRedactionJobIds');
    await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: DeletionKeys.deletionPk(orgId), sk: DeletionKeys.deletionSk() }),
        UpdateExpression: 'SET stripeRedactionJobIds.#cid = :jobId, updatedAt = :now',
        ConditionExpression: replacing
          ? 'attribute_exists(pk) AND stripeRedactionJobIds.#cid = :replacing'
          : 'attribute_exists(pk) AND attribute_not_exists(stripeRedactionJobIds.#cid)',
        ExpressionAttributeNames: { '#cid': customerId },
        ExpressionAttributeValues: marshall({
          ':jobId': jobId,
          ':now': new Date().toISOString(),
          ...(replacing ? { ':replacing': replacing } : {}),
        }),
      }),
    );
    rememberJobId(record, customerId, jobId);
    return jobId;
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    const stored = (await readDeletionRecord(orgId))?.stripeRedactionJobIds?.[customerId];
    if (!stored) {
      // The condition can only fail because another worker moved the slot or the
      // record is gone (the seed above fails only for the latter); either way a
      // missing id on re-read needs a retry, not a guess.
      throw new Error(
        `Deletion record for org ${orgId} rejected redaction job id ${jobId} for customer ` +
          `${customerId} but no stored id was found on re-read; the next teardown pass retries`,
      );
    }
    console.warn('[stripe-redaction] Redaction job id already persisted by a concurrent worker', {
      orgId,
      customerId,
      jobId,
      storedJobId: stored,
    });
    rememberJobId(record, customerId, stored);
    return stored;
  }
}

/**
 * Create a keyed map attribute on the DELETION record if it has none, so the
 * nested `SET map.#key` write above has a parent to address — a nested SET
 * cannot create the map itself. Idempotent; leaves an existing map intact.
 */
async function seedMapAttribute(orgId: string, attribute: string): Promise<void> {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: DeletionKeys.deletionPk(orgId), sk: DeletionKeys.deletionSk() }),
      UpdateExpression: 'SET #attr = if_not_exists(#attr, :empty)',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#attr': attribute },
      ExpressionAttributeValues: marshall({ ':empty': {} }),
    }),
  );
}

/** Keep the in-memory record in step, so a later pass in THIS run sees the id. */
function rememberJobId(record: OrgDeletionRecord, customerId: string, jobId: string): void {
  record.stripeRedactionJobIds = { ...(record.stripeRedactionJobIds ?? {}), [customerId]: jobId };
}

async function stripeRawRequest<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return (await getStripeClient().rawRequest(method, path, params)) as T;
}

/**
 * Given a job-creation error, does the customer still exist and therefore
 * still need redacting? Deliberately narrow: only Stripe's `resource_missing`
 * code means "nothing to redact". Message sniffing (e.g. matching
 * "already ... redact") is dangerous here — "already included in a redaction
 * job" would read as already-REDACTED and skip driving the conflicting job's
 * lifecycle (see {@link isRedactionJobConflict}).
 */
function isCustomerRedactable(err: unknown): boolean {
  const e = err as { code?: string };
  return e.code !== 'resource_missing';
}

/**
 * Job creation rejected because the customer is already included in another
 * redaction job. Stripe ships no dedicated error code for this conflict, so
 * the message is matched — narrowly, requiring "redaction job" so a genuine
 * already-redacted message can never satisfy it.
 */
function isRedactionJobConflict(err: unknown): boolean {
  const e = err as { message?: string };
  return /already.{0,40}redaction job/i.test(e.message ?? '');
}
