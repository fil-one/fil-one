// RAG indexer orchestrator: a cron-triggered scan that fans out indexing work
// per org. It scans the per-bucket RAG enablement rows (UserInfoTable —
// BUCKET#{region}#{bucketName} / RAG), groups the active ones by their owning org, and
// async-invokes the worker once per org (InvocationType 'Event'). It has no
// side effects beyond those invocations; all S3/vector work lives in the worker.

import { ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
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
  const workerFunctionName = process.env.RAG_INDEXER_WORKER_FUNCTION_NAME!;

  console.log(`${LOG} Starting RAG index reconciliation`);

  const buckets = await scanEnabledBuckets();
  console.log(`${LOG} Found RAG-enabled buckets`, { count: buckets.length });
  if (buckets.length === 0) return;

  const bucketsByOrg = groupByOrg(buckets);

  let invoked = 0;
  let failed = 0;
  for (const [orgId, buckets] of bucketsByOrg) {
    if (await invokeWorker(workerFunctionName, { orgId, buckets })) {
      invoked++;
    } else {
      failed++;
    }
  }

  console.log(`${LOG} Complete`, {
    totalBuckets: buckets.length,
    uniqueOrgs: bucketsByOrg.size,
    invoked,
    failed,
  });
}

/**
 * Scan every active per-bucket RAG enablement row. Filters on the RAG sk and an
 * `active` status so paused/disabled buckets are left alone. Rows missing an
 * `orgId` (which the worker cannot route) are logged and skipped.
 */
async function scanEnabledBuckets(): Promise<EnabledBucket[]> {
  const buckets: EnabledBucket[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: Resource.UserInfoTable.name,
        FilterExpression: 'sk = :sk AND #status = :active',
        ExpressionAttributeNames: { '#status': 'status' },
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
        console.warn(`${LOG} Enablement row has an unparseable bucket pk, skipping`, {
          pk: record.pk,
        });
        continue;
      }
      if (!record.orgId) {
        console.warn(`${LOG} Enablement row missing orgId, skipping`, {
          bucketName: parsed.bucketName,
        });
        continue;
      }
      buckets.push({ region: parsed.region, bucketName: parsed.bucketName, orgId: record.orgId });
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return buckets;
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
