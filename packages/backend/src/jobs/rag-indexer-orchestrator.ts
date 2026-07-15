// RAG indexer orchestrator: a cron-triggered scan that fans out work per org. It
// scans the per-bucket RAG enablement rows (RagIndexerTable —
// BUCKET#{orgId}#{region}#{bucketName} / RAG) and selects two sets: `active`
// buckets (to index) and buckets carrying a `teardownPendingAt` marker (to tear
// down — the backstop for a set-enablement invoke that was lost or failed). It
// groups each set by owning org and async-invokes the worker once per (org,
// mode) with InvocationType 'Event'. It has no side effects beyond those
// invocations; all S3/vector work lives in the worker.

import { ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';
import { getDynamoClient } from '../lib/ddb-client.js';
import { RAGKeys } from '../lib/dynamo-records.js';
import type {
  RagIndexerBucketRef,
  RagIndexerWorkerMode,
  RagIndexerWorkerPayload,
} from './rag-indexer-worker.js';
import type { S3Region } from '@filone/shared';

const dynamo = getDynamoClient();
const lambda = new LambdaClient({});

const LOG = '[rag-indexer-orchestrator]';

interface SelectedBucket {
  region: S3Region;
  bucketName: string;
  orgId: string;
  mode: RagIndexerWorkerMode;
}

export async function handler(): Promise<void> {
  const workerFunctionName = process.env.RAG_INDEXER_WORKER_FUNCTION_NAME!;

  console.log(`${LOG} Starting RAG index reconciliation`);

  const buckets = await scanSelectedBuckets();
  const indexBuckets = buckets.filter((bucket) => bucket.mode === 'index');
  const teardownBuckets = buckets.filter((bucket) => bucket.mode === 'teardown');
  console.log(`${LOG} Found buckets`, {
    index: indexBuckets.length,
    teardown: teardownBuckets.length,
  });
  if (buckets.length === 0) return;

  const byOrgIndex = groupByOrg(indexBuckets);
  const byOrgTeardown = groupByOrg(teardownBuckets);

  let invoked = 0;
  let failed = 0;
  for (const [orgId, refs] of byOrgIndex) {
    if (await invokeWorker(workerFunctionName, { orgId, buckets: refs, mode: 'index' })) invoked++;
    else failed++;
  }
  for (const [orgId, refs] of byOrgTeardown) {
    if (await invokeWorker(workerFunctionName, { orgId, buckets: refs, mode: 'teardown' }))
      invoked++;
    else failed++;
  }

  console.log(`${LOG} Complete`, {
    totalBuckets: buckets.length,
    indexOrgs: byOrgIndex.size,
    teardownOrgs: byOrgTeardown.size,
    invoked,
    failed,
  });
}

/**
 * Scan the per-bucket RAG enablement rows and select those needing work: rows
 * with `status = active` (to index) OR carrying a `teardownPendingAt` marker (to
 * tear down). Paused/disabled rows with no pending teardown are left alone. A
 * row is classified `index` when active, else `teardown` — so a re-enabled
 * bucket (active) is indexed and never torn down even if a stale marker lingers.
 * Rows missing an `orgId` (which the worker cannot route) are logged and skipped.
 */
async function scanSelectedBuckets(): Promise<SelectedBucket[]> {
  const buckets: SelectedBucket[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: Resource.RagIndexerTable.name,
        FilterExpression: 'sk = :sk AND (#status = :active OR attribute_exists(teardownPendingAt))',
        ExpressionAttributeNames: { '#status': 'status' },
        ProjectionExpression: 'pk, orgId, #status, teardownPendingAt',
        ExpressionAttributeValues: {
          ':sk': { S: RAGKeys.enablementSk() },
          ':active': { S: 'active' },
        },
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );

    for (const item of result.Items ?? []) {
      const selected = toSelectedBucket(unmarshall(item));
      if (selected) buckets.push(selected);
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return buckets;
}

/**
 * Project one enablement row into a {@link SelectedBucket}, or `null` when it
 * cannot be routed (unparseable bucket pk, or missing orgId — both logged). A
 * row is classified `index` when active, else `teardown`.
 */
function toSelectedBucket(record: Record<string, unknown>): SelectedBucket | null {
  const parsed = typeof record.pk === 'string' ? RAGKeys.parseBucketPk(record.pk) : undefined;
  if (!parsed) {
    console.warn(`${LOG} Enablement row has an unparseable bucket pk, skipping`, { pk: record.pk });
    return null;
  }
  if (typeof record.orgId !== 'string' || !record.orgId) {
    console.warn(`${LOG} Enablement row missing orgId, skipping`, {
      bucketName: parsed.bucketName,
    });
    return null;
  }
  const mode: RagIndexerWorkerMode = record.status === 'active' ? 'index' : 'teardown';
  return { region: parsed.region, bucketName: parsed.bucketName, orgId: record.orgId, mode };
}

function groupByOrg(buckets: SelectedBucket[]): Map<string, RagIndexerBucketRef[]> {
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
    console.error(`${LOG} Failed to invoke worker`, {
      orgId: payload.orgId,
      mode: payload.mode,
      error,
    });
    return false;
  }
}
