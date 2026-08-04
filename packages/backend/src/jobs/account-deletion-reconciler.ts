import { ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { OrgDeletionStatus, type OrgDeletionRecord } from '../lib/dynamo-records.js';
import { reportMetric } from '../lib/metrics.js';
import type { AccountDeletionWorkerPayload } from './account-deletion-worker.js';

const dynamo = getDynamoClient();
const lambda = new LambdaClient({});

/** Ignore records the worker touched more recently than this — it's live. */
const STALE_AFTER_MS = 10 * 60 * 1000;
/** Past this many worker attempts the record counts as stuck (alerting gauge). */
const STUCK_ATTEMPT_THRESHOLD = 3;

/**
 * Rescues account deletions whose worker died mid-teardown (FIL-112): scans
 * for DELETION records that are not DONE and have not advanced recently,
 * re-invokes the worker for each, and emits StuckAccountDeletionCount so
 * repeatedly-failing teardowns surface in Grafana. The user was already told
 * deletion succeeded — this cron is what makes that promise eventually true.
 */
export async function handler(): Promise<void> {
  const workerFunctionName = process.env.ACCOUNT_DELETION_WORKER_FUNCTION_NAME!;
  const now = Date.now();

  const incomplete = await scanIncompleteDeletions();
  const stale = incomplete.filter(
    (record) => now - new Date(record.updatedAt).getTime() > STALE_AFTER_MS,
  );
  const stuck = incomplete.filter((record) => record.attemptCount >= STUCK_ATTEMPT_THRESHOLD);

  let reinvoked = 0;
  let failed = 0;
  for (const record of stale) {
    const orgId = record.pk.slice('ORG#'.length);
    try {
      const payload: AccountDeletionWorkerPayload = { orgId };
      await lambda.send(
        new InvokeCommand({
          FunctionName: workerFunctionName,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify(payload)),
        }),
      );
      reinvoked += 1;
    } catch (error) {
      failed += 1;
      console.error('[account-deletion-reconciler] Failed to re-invoke worker', { orgId, error });
    }
  }

  console.log('[account-deletion-reconciler] Reconcile complete', {
    incomplete: incomplete.length,
    stale: stale.length,
    reinvoked,
    failed,
    stuck: stuck.length,
  });

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
    StuckAccountDeletionCount: stuck.length,
  });
}

// At current scale (< a few thousand orgs, running twice a day) a Scan with
// FilterExpression is fine, even though it consumes RCUs for the whole table
// regardless of the filter. TODO: if org count grows, add a sparse GSI on a
// deletionStatus attribute carried only by non-DONE DELETION rows — with the
// wrinkle that DELETION rows are retained forever as audit records, so the
// finalize step must REMOVE the attribute for the index to stay
// O(active deletions).
async function scanIncompleteDeletions(): Promise<OrgDeletionRecord[]> {
  const records: OrgDeletionRecord[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: Resource.UserInfoTable.name,
        FilterExpression: 'sk = :deletion AND #s <> :done',
        // Trim the returned payload to what the handler actually reads.
        ProjectionExpression: 'pk, updatedAt, attemptCount',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':deletion': { S: 'DELETION' },
          ':done': { S: OrgDeletionStatus.Done },
        },
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );
    records.push(...(result.Items ?? []).map((item) => unmarshall(item) as OrgDeletionRecord));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return records;
}
