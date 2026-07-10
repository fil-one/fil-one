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

  console.log('[account-deletion-reconciler] Scan complete', {
    incomplete: incomplete.length,
    reinvoked: stale.length,
    stuck: stuck.length,
  });

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
    } catch (error) {
      console.error('[account-deletion-reconciler] Failed to re-invoke worker', { orgId, error });
    }
  }

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

async function scanIncompleteDeletions(): Promise<OrgDeletionRecord[]> {
  const records: OrgDeletionRecord[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: Resource.UserInfoTable.name,
        FilterExpression: 'sk = :deletion AND #s <> :done',
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
