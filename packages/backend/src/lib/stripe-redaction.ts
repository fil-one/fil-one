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
}

/**
 * Redact the canceled customer's PII via Stripe's Redaction Jobs API. The org
 * ↔ Stripe customer relationship is 1:1 by domain, so exactly one customer is
 * redacted per teardown. The pinned SDK (22.0.2) has no
 * `privacy.redactionJobs` namespace, so the REST endpoints are driven through
 * `stripe.rawRequest`.
 *
 * Job lifecycle: created → (validate) → validating → ready → (run) →
 * redacting → succeeded. Validation is asynchronous, so a single pass may find
 * the job short of `ready`; the job id is persisted on the DELETION record at
 * creation, and a not-yet-ready job throws so the record stays non-DONE and
 * the Lambda retry / orchestrator advances the SAME job (never a duplicate) on
 * the next pass. `redacting`/`succeeded` count as done — redaction is
 * irreversible once running.
 */
export async function redactStripeCustomers(
  orgId: string,
  record: OrgDeletionRecord,
  customerId: string | undefined,
): Promise<void> {
  if (!customerId) return;

  let jobId = record.stripeRedactionJobId;
  if (!jobId) {
    const established = await establishRedactionJob(orgId, customerId);
    if (!established) return; // customer missing — nothing to redact
    jobId = established;
    record.stripeRedactionJobId = jobId;
  }

  await advanceRedactionJob(orgId, jobId);
}

/**
 * Create the customer's redaction job and persist its id — or, when Stripe
 * reports the customer is already in another (live) redaction job, recover and
 * persist THAT job's id so its lifecycle gets driven instead of the redaction
 * being skipped. Returns `null` only when the customer no longer exists.
 */
async function establishRedactionJob(orgId: string, customerId: string): Promise<string | null> {
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
    return persistRedactionJobId(orgId, await findRedactionJobIdForCustomer(orgId, customerId));
  }

  // Persist may lose against a concurrent worker — the stored id wins, and
  // only OUR freshly created job gets the initial validate kick (the stored
  // one's lifecycle is driven by advanceRedactionJob).
  const jobId = await persistRedactionJobId(orgId, created.id);
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
 */
async function findRedactionJobIdForCustomer(orgId: string, customerId: string): Promise<string> {
  const jobs = await stripeRawRequest<StripeRedactionJobList>('GET', '/v1/privacy/redaction_jobs', {
    limit: 100,
  });
  const match = (jobs.data ?? []).find(
    (job) =>
      job.status !== 'failed' &&
      job.status !== 'canceled' &&
      (job.objects?.customers ?? []).includes(customerId),
  );
  if (!match) {
    throw new Error(
      `Stripe reported customer ${customerId} (org ${orgId}) is already in a redaction job, but ` +
        'no live job containing them was found; the next teardown pass retries',
    );
  }
  return match.id;
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

/**
 * Persist the redaction job id — but only if none is stored yet. Two
 * overlapping workers can each create/recover a job; an unconditional SET
 * would let the loser overwrite the winner and leave a duplicate redaction job
 * driving nowhere. On a conditional failure the stored id wins: it is re-read
 * and returned so the caller drives THAT job.
 *
 * @returns the effective job id — `jobId` when this write won, otherwise the
 *          id another worker persisted first.
 */
async function persistRedactionJobId(orgId: string, jobId: string): Promise<string> {
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: DeletionKeys.deletionPk(orgId), sk: DeletionKeys.deletionSk() }),
        UpdateExpression: 'SET stripeRedactionJobId = :jobId, updatedAt = :now',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(stripeRedactionJobId)',
        ExpressionAttributeValues: marshall({
          ':jobId': jobId,
          ':now': new Date().toISOString(),
        }),
      }),
    );
    return jobId;
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    const stored = (await readDeletionRecord(orgId))?.stripeRedactionJobId;
    if (!stored) {
      // The condition can only fail because the id exists or the record is
      // gone; either way a missing id on re-read needs a retry, not a guess.
      throw new Error(
        `Deletion record for org ${orgId} rejected redaction job id ${jobId} but no stored id ` +
          'was found on re-read; the next teardown pass retries',
      );
    }
    console.warn('[stripe-redaction] Redaction job id already persisted by a concurrent worker', {
      orgId,
      jobId,
      storedJobId: stored,
    });
    return stored;
  }
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
