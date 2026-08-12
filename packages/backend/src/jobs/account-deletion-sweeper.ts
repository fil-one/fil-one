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

/** Passes beyond which a teardown is not retrying, it is wedged. */
const WEDGED_ATTEMPTS = 10;

interface StuckDeletion {
  orgId: string;
  attempts: number;
}

/**
 * Re-drives teardowns that stalled. This is the other half of the async invoke's
 * at-most-once delivery: the DELETION record is the source of truth, so a
 * confirm whose invoke never landed, a worker that exhausted its retries into
 * the DLQ, and a pass killed mid-purge all converge here.
 */
export async function handler(): Promise<void> {
  const stuck = await scanStuckDeletions();
  const wedged = stuck.filter((record) => record.attempts > WEDGED_ATTEMPTS);

  reportStuckCount(stuck.length);
  for (const record of wedged) {
    reportWedged(record);
  }

  for (const { orgId, attempts } of stuck) {
    console.log(`${LOG} re-driving`, { orgId, attempts });
    await invokeAccountDeletionWorker(orgId);
  }

  console.log(`${LOG} complete`, { stuck: stuck.length, wedged: wedged.length });
}

/**
 * A paged Scan: UserInfoTable has only the pk/sk index, so there is no way to
 * query for pending deletions. The filter trims what is returned, not what is
 * read — fine at current table size, and the escape at scale is a sparse GSI on
 * an attribute present only while PENDING.
 */
async function scanStuckDeletions(): Promise<StuckDeletion[]> {
  const dynamo = getDynamoClient();
  const cutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60 * 1000).toISOString();
  const stuck: StuckDeletion[] = [];
  let cursor: Record<string, AttributeValue> | undefined;

  do {
    const page = await dynamo.send(
      new ScanCommand({
        TableName: Resource.UserInfoTable.name,
        FilterExpression: 'sk = :sk AND #status <> :done AND updatedAt < :cutoff',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':sk': 'DELETION',
          ':done': DELETION_STATUS.done,
          ':cutoff': cutoff,
        }),
        ProjectionExpression: 'pk, attempts',
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );

    for (const item of page.Items ?? []) {
      const pk = item.pk?.S;
      if (!pk) continue;
      stuck.push({
        orgId: pk.replace('ORG#', ''),
        attempts: Number(item.attempts?.N ?? '0'),
      });
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  return stuck;
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

/** Carries the orgId so an operator can go straight to the record. */
function reportWedged({ orgId, attempts }: StuckDeletion): void {
  console.error(`${LOG} deletion is wedged and needs an operator`, { orgId, attempts });
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['orgId']],
          Metrics: [{ Name: 'WedgedAccountDeletion', Unit: 'Count' }],
        },
      ],
    },
    orgId,
    WedgedAccountDeletion: 1,
  });
}
