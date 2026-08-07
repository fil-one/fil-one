import { ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { batchGet } from '../lib/dynamo-batch-get.js';
import { OrgDeletionStatus, type OrgDeletionRecord } from '../lib/dynamo-records.js';
import { reportMetric } from '../lib/metrics.js';
import type { AccountDeletionWorkerPayload } from './account-deletion-worker.js';

const dynamo = getDynamoClient();
const lambda = new LambdaClient({});

/**
 * Ignore records the worker touched more recently than this — it's live.
 * Must exceed the worker's 900s Lambda timeout: the worker bumps `updatedAt`
 * once per pass (bumpAttemptCount), so a window shorter than a pass could
 * re-invoke against a still-running worker. 60 minutes leaves generous room
 * for the worker's own async retries too.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;
/** Past this many worker attempts the record counts as stuck (alerting gauge). */
const STUCK_ATTEMPT_THRESHOLD = 3;

/**
 * Rescues account deletions whose worker died mid-teardown (FIL-112): scans
 * for DELETION records that are not DONE and have not advanced recently,
 * re-invokes the worker for each, and emits StuckAccountDeletionCount so
 * repeatedly-failing teardowns surface in Grafana. The user was already told
 * deletion succeeded — this cron is what makes that promise eventually true.
 *
 * Also sweeps DONE records for resurrected billing rows (FIL-112): a handful
 * of unguarded billing writers (createBillingTrial's fill-in UpdateItem, and
 * the lazy trial→grace transition writes) can land AFTER the purge and
 * upsert a fresh CUSTOMER#{userId}/SUBSCRIPTION row for a deleted user. That
 * row carries no `deletionRequestedAt` (the purge is what would have set it,
 * and it never ran against this row), so no scan predicate on BillingTable
 * can ever find it — the DELETION record's `members` is the only durable
 * orgId → userIds map left once teardown completes, which is why this join
 * has to start from DONE records instead of from BillingTable.
 */
export async function handler(): Promise<void> {
  const workerFunctionName = process.env.ACCOUNT_DELETION_WORKER_FUNCTION_NAME!;
  const now = Date.now();

  // If the scan itself fails, the handler throws here and NO metric is
  // emitted this run — deliberate: an absent gauge alerts differently from a
  // zero, and the cron's own error metric covers the scan failure.
  const records = await scanDeletionRecords();
  const incomplete = records.filter((record) => record.status !== OrgDeletionStatus.Done);
  const done = records.filter((record) => record.status === OrgDeletionStatus.Done);

  const stale = incomplete.filter((record) => isStale(record, now));
  const stuck = incomplete.filter((record) => record.attemptCount >= STUCK_ATTEMPT_THRESHOLD);
  const resurrected = await findResurrectedDoneOrgs(done);

  // Emit both gauges BEFORE the re-invokes: they must reach CloudWatch even
  // when a later worker invoke fails.
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [
            { Name: 'StuckAccountDeletionCount', Unit: 'Count' },
            { Name: 'ResurrectedAccountDeletionCount', Unit: 'Count' },
          ],
        },
      ],
    },
    StuckAccountDeletionCount: stuck.length,
    ResurrectedAccountDeletionCount: resurrected.length,
  });

  let reinvoked = 0;
  let failed = 0;
  for (const record of stale) {
    const orgId = record.pk.slice('ORG#'.length);
    if (await invokeWorker(workerFunctionName, orgId)) reinvoked += 1;
    else failed += 1;
  }
  for (const { orgId } of resurrected) {
    if (await invokeWorker(workerFunctionName, orgId)) reinvoked += 1;
    else failed += 1;
  }

  console.log('[account-deletion-orchestrator] Reconcile complete', {
    incomplete: incomplete.length,
    stale: stale.length,
    reinvoked,
    failed,
    stuck: stuck.length,
  });
}

/** Event-invokes the worker for one org, via the same path stale and resurrected records both use. */
async function invokeWorker(workerFunctionName: string, orgId: string): Promise<boolean> {
  try {
    const payload: AccountDeletionWorkerPayload = { orgId };
    await lambda.send(
      new InvokeCommand({
        FunctionName: workerFunctionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
    return true;
  } catch (error) {
    console.error('[account-deletion-orchestrator] Failed to re-invoke worker', { orgId, error });
    return false;
  }
}

/**
 * For each DONE deletion record, checks whether any of its snapshotted
 * members still has a CUSTOMER#{userId}/SUBSCRIPTION row on BillingTable —
 * i.e. teardown finished but a billing row got resurrected afterward. Returns
 * one entry per org with at least one surviving row, `userIds` limited to
 * the ones that actually still exist.
 *
 * A billing lookup failure for one org is caught and logged so it can't
 * abort the sweep for the rest — `runAccountDeletion` is idempotent
 * end-to-end (re-purges by key, re-discovers/cancels/redacts via Stripe
 * metadata, re-marks DONE), so a missed org this run is simply picked up
 * again next run.
 */
async function findResurrectedDoneOrgs(
  done: ScannedDeletion[],
): Promise<{ orgId: string; userIds: string[] }[]> {
  const resurrected: { orgId: string; userIds: string[] }[] = [];
  for (const record of done) {
    const orgId = record.pk.slice('ORG#'.length);
    const userIds = (record.members ?? []).map((member) => member.userId).filter(Boolean);
    if (userIds.length === 0) continue;

    try {
      const keys = userIds.map((userId) => ({ pk: `CUSTOMER#${userId}`, sk: 'SUBSCRIPTION' }));
      const survivors = await batchGet(Resource.BillingTable.name, keys);
      const survivingUserIds = survivors
        .map((item) => item.pk)
        .filter((pk): pk is string => typeof pk === 'string')
        .map((pk) => pk.slice('CUSTOMER#'.length));
      if (survivingUserIds.length > 0) {
        console.warn(
          '[account-deletion-orchestrator] Billing row(s) resurrected after completed teardown — re-driving',
          { orgId, userIds: survivingUserIds },
        );
        resurrected.push({ orgId, userIds: survivingUserIds });
      }
    } catch (error) {
      console.error(
        '[account-deletion-orchestrator] Failed to check for resurrected billing rows',
        { orgId, error },
      );
    }
  }
  return resurrected;
}

/**
 * Staleness check with a NaN guard: a garbled or missing `updatedAt` parses
 * to NaN, and `NaN > x` is false — such a record would silently NEVER look
 * stale and never be re-driven. Treat it as stale (and warn) instead.
 */
function isStale(record: IncompleteDeletion, now: number): boolean {
  const updatedAtMs = new Date(record.updatedAt).getTime();
  if (Number.isNaN(updatedAtMs)) {
    console.warn(
      '[account-deletion-orchestrator] Record has an unparseable updatedAt; treating as stale',
      {
        pk: record.pk,
        updatedAt: record.updatedAt,
      },
    );
    return true;
  }
  return now - updatedAtMs > STALE_AFTER_MS;
}

/** What the lean ProjectionExpression below actually returns per record. */
type IncompleteDeletion = Pick<OrgDeletionRecord, 'pk' | 'updatedAt' | 'attemptCount'>;

/**
 * Superset of {@link IncompleteDeletion}: every DELETION record now comes
 * back from the scan (DONE included), so the handler can route each record
 * by `status` — `members` is only read for DONE records, by the
 * resurrection sweep.
 */
type ScannedDeletion = IncompleteDeletion & Pick<OrgDeletionRecord, 'status' | 'members'>;

// At current scale (< a few thousand orgs, running twice a day) a Scan with
// FilterExpression is fine, even though it consumes RCUs for the whole table
// regardless of the filter. The scan now also pulls back DONE records (for
// the resurrection sweep below), which only adds to the case for the TODO:
// if org count grows, add a sparse GSI on a deletionStatus attribute carried
// only by non-DONE DELETION rows — with the wrinkle that DELETION rows are
// retained forever as audit records, so the finalize step must REMOVE the
// attribute for the index to stay O(active deletions). DONE records would
// still need their own (much cheaper — no RCU-relevant filter, just a status
// check) path to the resurrection sweep, but at least the per-org Scan cost
// disappears.
async function scanDeletionRecords(): Promise<ScannedDeletion[]> {
  const records: ScannedDeletion[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: Resource.UserInfoTable.name,
        // begins_with(pk, :orgPrefix) keeps any future non-ORG row that
        // happens to carry an sk of DELETION out of the orchestrator (same
        // pattern as lib/stuck-tenant-metric.ts). No longer filters out DONE
        // records — the resurrection sweep needs those too.
        FilterExpression: 'begins_with(pk, :orgPrefix) AND sk = :deletion',
        // Trim the returned payload to what the handler actually reads.
        // #s (status) is needed to route DONE vs. non-DONE; #m (members) is
        // needed only for the DONE-record resurrection sweep.
        ProjectionExpression: 'pk, updatedAt, attemptCount, #s, #m',
        ExpressionAttributeNames: { '#s': 'status', '#m': 'members' },
        ExpressionAttributeValues: {
          ':orgPrefix': { S: 'ORG#' },
          ':deletion': { S: 'DELETION' },
        },
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );
    records.push(...(result.Items ?? []).map((item) => unmarshall(item) as ScannedDeletion));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return records;
}
