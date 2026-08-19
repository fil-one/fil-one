import { ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { invokeAccountDeletionWorker } from '../lib/account-deletion-invoke.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { DELETION_STATUS } from '../lib/deletion-record.js';
import { reportMetric } from '../lib/metrics.js';

const LOG = '[account-deletion-sweeper]';

/**
 * Deliberately double the worker's 15-minute Lambda ceiling, so at most one
 * sweeper invoke can overlap a live pass. Overlap is harmless — every step is
 * idempotent and there is no lock — but the worker must bump `updatedAt` at the
 * start of each pass or a healthy long purge looks stale.
 */
const STALE_AFTER_MINUTES = 30;

/** Passes beyond which a teardown is not retrying, it is blocked. */
const BLOCKED_ATTEMPTS = 10;

const HOUR_MS = 60 * 60 * 1000;

interface PendingDeletion {
  orgId: string;
  attempts: number;
  requestedAt: string;
  updatedAt: string;
}

/**
 * Re-drives teardowns that stalled. This is the other half of the async invoke's
 * at-most-once delivery: the DELETION record is the source of truth, so a
 * confirm whose invoke never landed, a worker that exhausted its retries into
 * the DLQ, and a pass killed mid-purge all converge here.
 */
export async function handler(): Promise<void> {
  const pending = await scanPendingDeletions();
  const cutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60 * 1000).toISOString();
  const stuck = pending.filter((record) => record.updatedAt < cutoff);
  const blocked = stuck.filter((record) => record.attempts > BLOCKED_ATTEMPTS);

  // Both gauges are emitted every run, including at zero, so an alert on them
  // auto-clears rather than staying lit on the last bad value.
  reportStuckCount(stuck.length);
  reportOldestPendingAge(pending);
  for (const record of blocked) {
    reportBlocked(record);
  }

  for (const { orgId, attempts } of stuck) {
    console.log(`${LOG} re-driving`, { orgId, attempts });
    await invokeAccountDeletionWorker(orgId);
  }

  console.log(`${LOG} complete`, {
    pending: pending.length,
    stuck: stuck.length,
    blocked: blocked.length,
  });
}

/**
 * Every deletion not yet DONE, stale or not: the age gauge measures the oldest of
 * all of them, and the staleness split is a comparison the caller makes.
 *
 * A paged Scan, because UserInfoTable has only the pk/sk index. The filter trims
 * what is returned, not what is read — fine at current table size, and the escape
 * at scale is a sparse GSI on an attribute present only while PENDING.
 */
async function scanPendingDeletions(): Promise<PendingDeletion[]> {
  const dynamo = getDynamoClient();
  const pending: PendingDeletion[] = [];
  let cursor: Record<string, AttributeValue> | undefined;

  do {
    const page = await dynamo.send(
      new ScanCommand({
        TableName: Resource.UserInfoTable.name,
        FilterExpression: 'sk = :sk AND #status <> :done',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':sk': 'DELETION',
          ':done': DELETION_STATUS.done,
        }),
        ProjectionExpression: 'pk, attempts, requestedAt, updatedAt',
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );

    for (const item of page.Items ?? []) {
      const pk = item.pk?.S;
      if (!pk) continue;
      pending.push({
        orgId: pk.replace('ORG#', ''),
        attempts: Number(item.attempts?.N ?? '0'),
        requestedAt: item.requestedAt?.S ?? '',
        updatedAt: item.updatedAt?.S ?? '',
      });
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  return pending;
}

function reportStuckCount(count: number): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [{ Name: 'StuckAccountDeletionCount', Unit: 'Count' }],
        },
      ],
    },
    StuckAccountDeletionCount: count,
  });
}

/**
 * The age of the oldest deletion still running, which is a different question
 * from whether any has stalled: a teardown can bump `updatedAt` every pass and
 * still never finish. A Grafana alert at 168 hours encodes the seven-day
 * completion promise in the customer documentation.
 */
function reportOldestPendingAge(pending: PendingDeletion[]): void {
  const now = Date.now();
  const ages = pending
    .map((record) => Date.parse(record.requestedAt))
    .filter((requestedAt) => !Number.isNaN(requestedAt))
    .map((requestedAt) => (now - requestedAt) / HOUR_MS);

  reportMetric({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          // CloudWatch has no Hours unit; the metric name carries it.
          Metrics: [{ Name: 'OldestPendingDeletionAgeHours', Unit: 'None' }],
        },
      ],
    },
    OldestPendingDeletionAgeHours: ages.length > 0 ? Math.max(...ages) : 0,
  });
}

/**
 * No dimension: the paired log line carries the orgId, and a Loki JSON query on
 * it is the pattern the FTH errors and tenant-setup failures already use. An
 * orgId dimension would put unbounded cardinality in the metric stream.
 */
function reportBlocked({ orgId, attempts }: PendingDeletion): void {
  console.error(`${LOG} deletion is blocked and needs an operator`, { orgId, attempts });
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [{ Name: 'BlockedAccountDeletion', Unit: 'Count' }],
        },
      ],
    },
    BlockedAccountDeletion: 1,
  });
}
