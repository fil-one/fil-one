// RAG indexer orchestrator: a cron-triggered scan that fans out indexing work
// per org. It scans the per-bucket RAG enablement rows (RagIndexerTable —
// BUCKET#{orgId}#{region}#{bucketName} / RAG), groups the active ones by their owning
// org, and async-invokes the worker once per org (InvocationType 'Event'). It has no
// side effects beyond those invocations; all S3/vector work lives in the worker.

import { ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { reportMetric } from '../lib/metrics.js';
import { RAGKeys } from '../lib/dynamo-records.js';
import type { RagIndexerBucketRef, RagIndexerWorkerPayload } from './rag-indexer-worker.js';
import type { S3Region } from '@filone/shared';

const dynamo = getDynamoClient();
const lambda = new LambdaClient({});

const LOG = '[rag-indexer-orchestrator]';

interface EnabledBucket {
  region: S3Region;
  bucketName: string;
  orgId: string;
}

export async function handler(): Promise<void> {
  const start = Date.now();
  const workerFunctionName = process.env.RAG_INDEXER_WORKER_FUNCTION_NAME!;

  console.log(`${LOG} Starting RAG index reconciliation`);

  const { buckets, skipped } = await scanEnabledBuckets();
  console.log(`${LOG} Found RAG-enabled buckets`, { count: buckets.length });
  if (buckets.length === 0) {
    emitOrchestratorMetrics({
      outcome: 'success',
      durationMs: Date.now() - start,
      dispatchSuccess: 0,
      dispatchFailure: 0,
      totalBuckets: 0,
      uniqueOrgs: 0,
      skippedRows: skipped,
    });
    return;
  }

  const bucketsByOrg = groupByOrg(buckets);

  // Declared outside the try so the catch can report whatever counts are known
  // so far if an invocation loop throws.
  let invoked = 0;
  let failed = 0;
  try {
    for (const [orgId, buckets] of bucketsByOrg) {
      if (await invokeWorker(workerFunctionName, { orgId, buckets })) {
        invoked++;
      } else {
        failed++;
      }
    }

    emitOrchestratorMetrics({
      outcome: 'success',
      durationMs: Date.now() - start,
      dispatchSuccess: invoked,
      dispatchFailure: failed,
      totalBuckets: buckets.length,
      uniqueOrgs: bucketsByOrg.size,
      skippedRows: skipped,
    });
  } catch (error) {
    emitOrchestratorMetrics({
      outcome: 'failure',
      durationMs: Date.now() - start,
      dispatchSuccess: invoked,
      dispatchFailure: failed,
      totalBuckets: buckets.length,
      uniqueOrgs: bucketsByOrg.size,
      skippedRows: skipped,
    });
    throw error;
  }

  console.log(`${LOG} Complete`, {
    totalBuckets: buckets.length,
    uniqueOrgs: bucketsByOrg.size,
    invoked,
    failed,
  });
}

/**
 * Emit a single CloudWatch EMF event summarising one orchestrator run. Emitted
 * on every path (zero buckets, normal completion, and failure) so the run-count
 * and duration series stay complete.
 */
function emitOrchestratorMetrics(data: {
  outcome: 'success' | 'failure';
  durationMs: number;
  dispatchSuccess: number;
  dispatchFailure: number;
  totalBuckets: number;
  uniqueOrgs: number;
  skippedRows: number;
}): void {
  const invocationMetricName =
    data.outcome === 'success'
      ? 'RagIndexerOrchestratorInvocationSuccess'
      : 'RagIndexerOrchestratorInvocationFailure';

  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [
            { Name: invocationMetricName, Unit: 'Count' },
            { Name: 'RagIndexerOrchestratorDuration', Unit: 'Milliseconds' },
            { Name: 'RagIndexerWorkerDispatchSuccess', Unit: 'Count' },
            { Name: 'RagIndexerWorkerDispatchFailure', Unit: 'Count' },
            { Name: 'RagIndexerTotalBuckets', Unit: 'Count' },
            { Name: 'RagIndexerUniqueOrgs', Unit: 'Count' },
            { Name: 'RagIndexerSkippedRows', Unit: 'Count' },
          ],
        },
      ],
    },
    [invocationMetricName]: 1,
    RagIndexerOrchestratorDuration: data.durationMs,
    RagIndexerWorkerDispatchSuccess: data.dispatchSuccess,
    RagIndexerWorkerDispatchFailure: data.dispatchFailure,
    RagIndexerTotalBuckets: data.totalBuckets,
    RagIndexerUniqueOrgs: data.uniqueOrgs,
    RagIndexerSkippedRows: data.skippedRows,
  });
}

/**
 * Scan every active per-bucket RAG enablement row. Filters on the RAG sk and an
 * `active` status so paused/disabled buckets are left alone. Rows missing an
 * `orgId` (which the worker cannot route) are logged and skipped.
 */
async function scanEnabledBuckets(): Promise<{ buckets: EnabledBucket[]; skipped: number }> {
  const buckets: EnabledBucket[] = [];
  let skipped = 0;
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: Resource.RagIndexerTable.name,
        FilterExpression: 'sk = :sk AND #status = :active',
        ExpressionAttributeNames: { '#status': 'status' },
        ProjectionExpression: 'pk, orgId',
        ExpressionAttributeValues: {
          ':sk': { S: RAGKeys.enablementSk() },
          ':active': { S: 'active' },
        },
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );

    for (const item of result.Items ?? []) {
      const record = unmarshall(item);
      const parsed = typeof record.pk === 'string' ? RAGKeys.parseBucketPk(record.pk) : undefined;
      if (!parsed) {
        skipped++;
        console.warn(`${LOG} Enablement row has an unparseable bucket pk, skipping`, {
          pk: record.pk,
        });
        continue;
      }
      if (!record.orgId) {
        skipped++;
        console.warn(`${LOG} Enablement row missing orgId, skipping`, {
          bucketName: parsed.bucketName,
        });
        continue;
      }
      buckets.push({ region: parsed.region, bucketName: parsed.bucketName, orgId: record.orgId });
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return { buckets, skipped };
}

function groupByOrg(buckets: EnabledBucket[]): Map<string, RagIndexerBucketRef[]> {
  const byOrg = new Map<string, RagIndexerBucketRef[]>();
  for (const { orgId, region, bucketName } of buckets) {
    const ref: RagIndexerBucketRef = { region, bucketName };
    const existing = byOrg.get(orgId);
    if (existing) existing.push(ref);
    else byOrg.set(orgId, [ref]);
  }
  return byOrg;
}

async function invokeWorker(
  workerFunctionName: string,
  payload: RagIndexerWorkerPayload,
): Promise<boolean> {
  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: workerFunctionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
    return true;
  } catch (error) {
    console.error(`${LOG} Failed to invoke worker`, { orgId: payload.orgId, error });
    return false;
  }
}
