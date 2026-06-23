// RAG indexer worker: keeps one org's RAG-enabled bucket indices in sync with
// S3. The orchestrator fans out one async invoke per org; this worker resolves
// the org's provisioned regions, builds an S3 client per region from the
// orchestrator's credentials, enumerates buckets, and reconciles each
// RAG-enabled bucket's vector index (object-level ETag diffing).
//
// Failures are isolated at the region and bucket level: one failing region or
// bucket is logged and does not abort the rest of the org's work.

import type { Context } from 'aws-lambda';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { S3VectorsStore, type VectorStore } from '@filone/rag-shared';
import { getDynamoClient } from '../lib/ddb-client.js';
import { getProvisionedRegions, type ProvisionedRegion } from '../lib/region-helpers.js';
import { createS3Client } from '../lib/s3-client.js';
import { RAGKeys, type BucketRAGStatus } from '../lib/dynamo-records.js';
import { updateBucketTelemetry } from '../lib/bucket-rag-enablement.js';
import { indexBucket } from './rag-indexer-helpers.js';

const dynamo = getDynamoClient();

const LOG = '[rag-indexer-worker]';

/**
 * Reserve this much of the Lambda budget for checkpoint/cleanup writes.
 * `indexBucket` stops starting new pages once the remaining budget drops below
 * this, checkpoints, and resumes on the next run. ~60s of headroom leaves room
 * to finish the in-flight page and persist the checkpoint before the hard stop.
 */
const DEADLINE_BUFFER_MS = 60_000;

export interface RagIndexerWorkerPayload {
  orgId: string;
  /** When omitted/empty, index every RAG-enabled bucket the org owns. */
  bucketIds?: string[];
}

/**
 * Returns the milliseconds remaining before the Lambda hard timeout. Defaults
 * to the Lambda {@link Context} (the production path); injectable in tests so
 * the deadline logic can be exercised without a live runtime.
 */
export type RemainingTimeFn = () => number;

export async function handler(
  event: RagIndexerWorkerPayload,
  context: Context,
  getRemainingTimeInMillis: RemainingTimeFn = () => context.getRemainingTimeInMillis(),
): Promise<void> {
  const { orgId, bucketIds } = event;
  const deadlineEpochMs = computeDeadline(getRemainingTimeInMillis);

  const regions = await getProvisionedRegions(orgId);
  if (regions.length === 0) {
    console.warn(`${LOG} Org not provisioned in any available region, skipping`, { orgId });
    return;
  }

  const vectorStore = new S3VectorsStore(Resource.RagVectorBucket.name);
  const filter = bucketIds && bucketIds.length > 0 ? new Set(bucketIds) : undefined;

  let regionsProcessed = 0;
  let bucketsIndexed = 0;
  let regionFailures = 0;

  for (const region of regions) {
    try {
      bucketsIndexed += await indexRegion({ orgId, region, vectorStore, filter, deadlineEpochMs });
      regionsProcessed++;
    } catch (error) {
      regionFailures++;
      console.error(`${LOG} Region failed, continuing`, {
        orgId,
        orchestrator: region.orchestrator.id,
        tenantId: region.tenantId,
        error,
      });
    }
  }

  console.log(`${LOG} Complete`, {
    orgId,
    regionsProcessed,
    regionFailures,
    bucketsIndexed,
  });
}

/**
 * Leave headroom before the Lambda hard-stops so checkpoints can be written.
 * Derives the deadline from the remaining-time budget reported by the Lambda
 * {@link Context} (`context.getRemainingTimeInMillis()`), the only reliable
 * signal for how long the invocation has left.
 */
function computeDeadline(getRemainingTimeInMillis: RemainingTimeFn): number {
  const remaining = getRemainingTimeInMillis();
  if (Number.isFinite(remaining) && remaining > DEADLINE_BUFFER_MS) {
    return Date.now() + (remaining - DEADLINE_BUFFER_MS);
  }
  // No reliable signal — let indexBucket run without an early deadline.
  return Number.POSITIVE_INFINITY;
}

interface IndexRegionArgs {
  orgId: string;
  region: ProvisionedRegion;
  vectorStore: VectorStore;
  filter: Set<string> | undefined;
  deadlineEpochMs: number;
}

/**
 * Reconcile every RAG-enabled bucket in a single region. Builds the S3 client
 * from the orchestrator's tenant credentials, lists the tenant's buckets, and
 * indexes each one whose RAG enablement row is `active`. Returns the number of
 * buckets reconciled. Per-bucket failures are isolated (logged, counted, and
 * skipped) so they do not abort the region.
 */
async function indexRegion(args: IndexRegionArgs): Promise<number> {
  const { orgId, region, vectorStore, filter, deadlineEpochMs } = args;
  const { orchestrator, tenantId } = region;

  const ctx = await orchestrator.getS3ClientContext(tenantId);
  const s3 = createS3Client(ctx);
  const buckets = await orchestrator.listBuckets(tenantId);

  let indexed = 0;
  for (const bucket of buckets) {
    const bucketId = bucket.bucketName;
    if (filter && !filter.has(bucketId)) continue;

    const status = await getBucketRagStatus(bucketId);
    if (status !== 'active') continue;

    try {
      await indexBucket(s3, bucketId, bucket.bucketName, vectorStore, { deadlineEpochMs });
      indexed++;
    } catch (error) {
      // Persist the failure so the UI can surface "Sync failed" + the reason.
      // Best-effort: a telemetry write failure must not mask the original error.
      const message = error instanceof Error ? error.message : String(error);
      try {
        await updateBucketTelemetry(bucket.bucketName, {
          syncState: 'error',
          lastSyncError: message,
        });
      } catch (telemetryError) {
        console.error(`${LOG} Failed to persist error telemetry`, { bucketId, telemetryError });
      }
      console.error(`${LOG} Bucket failed, continuing`, {
        orgId,
        orchestrator: orchestrator.id,
        bucketId,
        error,
      });
    }
  }
  return indexed;
}

/**
 * Read a bucket's RAG enablement status (BUCKET#{bucketId} / RAG). Returns
 * `undefined` when RAG was never enabled for the bucket, so the worker skips
 * non-RAG buckets returned by listBuckets.
 */
async function getBucketRagStatus(bucketId: string): Promise<BucketRAGStatus | undefined> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: RAGKeys.bucketPk(bucketId) },
        sk: { S: RAGKeys.enablementSk() },
      },
    }),
  );
  if (!result.Item) return undefined;
  const record = unmarshall(result.Item);
  return typeof record.status === 'string' ? (record.status as BucketRAGStatus) : undefined;
}
