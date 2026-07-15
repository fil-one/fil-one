// RAG indexer worker: keeps one org's RAG-enabled bucket companion indices in
// sync with S3, and tears them down when RAG is disabled. The orchestrator fans
// out one async invoke per org (per mode), handing this worker the authoritative
// list of buckets (each tagged with its region). The worker resolves the org's
// provisioned regions (for per-region tenant credentials), builds an S3 client
// per region, and either reconciles each bucket's companion index (object-level
// ETag diffing, `mode: 'index'`) or empties it and drops its manifest/checkpoint
// (`mode: 'teardown'`).
//
// Failures are isolated at the region and bucket level: one failing region or
// bucket is logged and does not abort the rest of the org's work.

import type { Context } from 'aws-lambda';
import { BucketObjectVectorStore } from '@filone/rag-shared';
import { getProvisionedRegions } from '../lib/region-helpers.js';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { createS3Client } from '../lib/s3-client.js';
import { BucketAlreadyExistsError } from '../lib/errors.js';
import {
  clearTeardownPending,
  getBucketRagEnablement,
  updateBucketTelemetry,
} from '../lib/bucket-rag-enablement.js';
import { indexBucket } from './rag-indexer-helpers.js';
import { clearCheckpoint, deleteAllManifestEntries } from './rag-indexer-manifest.js';
import { reportMetric } from '../lib/metrics.js';
import { S3Region } from '@filone/shared';

const LOG = '[rag-indexer-worker]';

/**
 * Reserve this much of the Lambda budget for checkpoint/cleanup writes.
 * `indexBucket` stops starting new pages once the remaining budget drops below
 * this, checkpoints, and resumes on the next run. ~60s of headroom leaves room
 * to finish the in-flight page and persist the checkpoint before the hard stop.
 */
const DEADLINE_BUFFER_MS = 60_000;

/** A single bucket to index, identified by its region + name (unique per region). */
export interface RagIndexerBucketRef {
  region: S3Region;
  bucketName: string;
}

/**
 * What the worker should do with the buckets in the payload. Absent means
 * `'index'` so orchestrator invocations that predate teardown stay valid.
 */
export type RagIndexerWorkerMode = 'index' | 'teardown';

export interface RagIndexerWorkerPayload {
  orgId: string;
  /** The authoritative set of buckets to act on, supplied by the caller. */
  buckets: RagIndexerBucketRef[];
  /** `'index'` (default) reconciles the companion index; `'teardown'` empties it. */
  mode?: RagIndexerWorkerMode;
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
  const start = Date.now();
  const { orgId, buckets, mode = 'index' } = event;
  const deadlineEpochMs = computeDeadline(getRemainingTimeInMillis);

  // Declared before the try so the failure path can still report how far the
  // invocation got before it threw.
  let regionsProcessed = 0;
  let bucketsProcessed = 0;
  let regionFailures = 0;

  try {
    const regions = await getProvisionedRegions(orgId);
    if (regions.length === 0) {
      console.warn(`${LOG} Org not provisioned in any available region, skipping`, { orgId });
      emitWorkerInvocation('success', Date.now() - start, { regionsProcessed, regionFailures });
      return;
    }

    // tenantId is required to build each region's S3 client; a region the org is
    // not provisioned in has no tenant and its buckets cannot be processed.
    const tenantByRegion = new Map<S3Region, string>(
      regions.map(({ orchestrator, tenantId }) => [orchestrator.region, tenantId]),
    );
    const bucketsByRegion = groupBucketsByRegion(buckets);

    for (const [region, bucketNames] of bucketsByRegion) {
      const tenantId = tenantByRegion.get(region);
      if (!tenantId) {
        console.warn(`${LOG} Bucket region not provisioned for org, skipping`, {
          orgId,
          region,
          bucketCount: bucketNames.length,
        });
        continue;
      }

      try {
        // Only indexing has per-region counts to report; a teardown run moves no
        // objects, so it emits no RagIndexer* region metrics (zeros there would
        // read as an idle indexer rather than a teardown).
        if (mode === 'teardown') {
          bucketsProcessed += await teardownRegion({ orgId, region, tenantId, bucketNames });
        } else {
          const stats = await indexRegion({
            orgId,
            region,
            tenantId,
            bucketNames,
            deadlineEpochMs,
          });
          bucketsProcessed += stats.bucketsIndexed;
          emitRegionMetrics({ region, ...stats });
        }
        regionsProcessed++;
      } catch (error) {
        regionFailures++;
        // A region that failed before indexing any bucket reports all of its
        // buckets as failed.
        if (mode !== 'teardown') {
          emitRegionMetrics({
            region,
            bucketsIndexed: 0,
            bucketsCheckpointed: 0,
            bucketFailures: bucketNames.length,
            objectsAdded: 0,
            objectsUpdated: 0,
            objectsRemoved: 0,
            objectsFailed: 0,
          });
        }
        console.error(`${LOG} Region failed, continuing`, { orgId, mode, region, tenantId, error });
      }
    }

    console.log(`${LOG} Complete`, {
      orgId,
      mode,
      regionsProcessed,
      regionFailures,
      bucketsProcessed,
    });

    emitWorkerInvocation('success', Date.now() - start, { regionsProcessed, regionFailures });
  } catch (error) {
    emitWorkerInvocation('failure', Date.now() - start, { regionsProcessed, regionFailures });
    throw error;
  }
}

/** Group the payload's buckets into the list of bucket names to index per region. */
function groupBucketsByRegion(buckets: RagIndexerBucketRef[]): Map<S3Region, string[]> {
  const byRegion = new Map<S3Region, string[]>();
  for (const { region, bucketName } of buckets) {
    const existing = byRegion.get(region);
    if (existing) existing.push(bucketName);
    else byRegion.set(region, [bucketName]);
  }
  return byRegion;
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
  region: S3Region;
  tenantId: string;
  bucketNames: string[];
  deadlineEpochMs: number;
}

/** Aggregated indexing outcome for a single region, emitted as CloudWatch metrics. */
interface RegionIndexStats {
  /** Buckets fully reconciled this run (`indexBucket` returned `completed: true`). */
  bucketsIndexed: number;
  /** Buckets that hit the deadline and checkpointed mid-way (`completed: false`). */
  bucketsCheckpointed: number;
  bucketFailures: number;
  objectsAdded: number;
  objectsUpdated: number;
  objectsRemoved: number;
  objectsFailed: number;
}

/**
 * Reconcile the given buckets in a single region. Resolves the region's
 * orchestrator, builds the S3 client from its tenant credentials, and indexes
 * each requested bucket into its companion index bucket — on the SAME provider
 * as the source bucket, so vectors never leave the tenant's storage. The
 * companion store is built per region (its S3 client and bucket-provisioning
 * callback are region/tenant-specific). Returns aggregated stats (buckets and
 * objects reconciled/failed). Per-bucket failures are isolated (logged,
 * counted, and skipped) so they do not abort the region.
 */
async function indexRegion(args: IndexRegionArgs): Promise<RegionIndexStats> {
  const { orgId, region, tenantId, bucketNames, deadlineEpochMs } = args;

  const orchestrator = getOrchestratorForRegion(region);
  const ctx = await orchestrator.getS3ClientContext(tenantId);
  const s3 = createS3Client(ctx);

  // The store provisions each companion bucket via the orchestrator (Aurora
  // buckets exist only through the Portal API), idempotently — this is the
  // backstop; enablement creates it up front so quota/name errors surface to
  // the user immediately. BucketAlreadyExistsError is the expected steady state.
  const vectorStore = new BucketObjectVectorStore(s3, {
    ensureBucket: async (companionBucket) => {
      try {
        await orchestrator.createBucket(tenantId, { bucketName: companionBucket });
      } catch (error) {
        if (!(error instanceof BucketAlreadyExistsError)) throw error;
      }
    },
  });

  const stats: RegionIndexStats = {
    bucketsIndexed: 0,
    bucketsCheckpointed: 0,
    bucketFailures: 0,
    objectsAdded: 0,
    objectsUpdated: 0,
    objectsRemoved: 0,
    objectsFailed: 0,
  };
  for (const bucketName of bucketNames) {
    try {
      const result = await indexBucket(
        { orgId, s3, region, bucketName, vectorStore },
        { deadlineEpochMs },
      );
      // Only fully reconciled buckets count as "indexed"; a bucket that hit the
      // deadline and checkpointed mid-way is tracked separately so throughput is
      // not inflated during timeouts (the next run resumes and completes it).
      if (result.completed) stats.bucketsIndexed++;
      else stats.bucketsCheckpointed++;
      // Object counts reflect work actually done this run, so they accumulate
      // regardless of whether the bucket completed or checkpointed.
      stats.objectsAdded += result.added;
      stats.objectsUpdated += result.updated;
      stats.objectsRemoved += result.removed;
      stats.objectsFailed += result.failed;
    } catch (error) {
      stats.bucketFailures++;
      // Persist the failure so the UI can surface "Sync failed" + the reason.
      // Best-effort: a telemetry write failure must not mask the original error.
      const message = error instanceof Error ? error.message : String(error);
      try {
        await updateBucketTelemetry(orgId, region, bucketName, {
          syncState: 'error',
          lastSyncError: message,
        });
      } catch (telemetryError) {
        console.error(`${LOG} Failed to persist error telemetry`, { bucketName, telemetryError });
      }
      console.error(`${LOG} Bucket failed, continuing`, {
        orgId,
        orchestrator: orchestrator.id,
        region,
        bucketName,
        error,
      });
    }
  }
  return stats;
}

/**
 * Emit per-region indexing counts (buckets + objects) as a single CloudWatch
 * metric event dimensioned by region.
 */
function emitRegionMetrics(stats: RegionIndexStats & { region: S3Region }): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['region']],
          Metrics: [
            { Name: 'RagIndexerBucketsIndexed', Unit: 'Count' },
            { Name: 'RagIndexerBucketsCheckpointed', Unit: 'Count' },
            { Name: 'RagIndexerBucketFailures', Unit: 'Count' },
            { Name: 'RagIndexerObjectsAdded', Unit: 'Count' },
            { Name: 'RagIndexerObjectsUpdated', Unit: 'Count' },
            { Name: 'RagIndexerObjectsRemoved', Unit: 'Count' },
            { Name: 'RagIndexerObjectsFailed', Unit: 'Count' },
          ],
        },
      ],
    },
    region: stats.region,
    RagIndexerBucketsIndexed: stats.bucketsIndexed,
    RagIndexerBucketsCheckpointed: stats.bucketsCheckpointed,
    RagIndexerBucketFailures: stats.bucketFailures,
    RagIndexerObjectsAdded: stats.objectsAdded,
    RagIndexerObjectsUpdated: stats.objectsUpdated,
    RagIndexerObjectsRemoved: stats.objectsRemoved,
    RagIndexerObjectsFailed: stats.objectsFailed,
  });
}

/**
 * Emit a single worker-invocation metric event (no dimensions): a success or
 * failure count, the invocation duration, and the region success/failure tally.
 */
function emitWorkerInvocation(
  outcome: 'success' | 'failure',
  durationMs: number,
  summary: { regionsProcessed: number; regionFailures: number },
): void {
  const outcomeMetricName =
    outcome === 'success'
      ? 'RagIndexerWorkerInvocationSuccess'
      : 'RagIndexerWorkerInvocationFailure';

  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [
            { Name: outcomeMetricName, Unit: 'Count' },
            { Name: 'RagIndexerWorkerDuration', Unit: 'Milliseconds' },
            { Name: 'RagIndexerRegionsProcessed', Unit: 'Count' },
            { Name: 'RagIndexerRegionFailures', Unit: 'Count' },
          ],
        },
      ],
    },
    [outcomeMetricName]: 1,
    RagIndexerWorkerDuration: durationMs,
    RagIndexerRegionsProcessed: summary.regionsProcessed,
    RagIndexerRegionFailures: summary.regionFailures,
  });
}

interface TeardownRegionArgs {
  orgId: string;
  region: S3Region;
  tenantId: string;
  bucketNames: string[];
}

/**
 * Tear down the given buckets' companion indices in a single region: empty the
 * companion bucket, delete every manifest row, drop the checkpoint, and clear
 * the `teardownPendingAt` marker. Returns the number of buckets torn down.
 *
 * Each bucket first re-reads its enablement row and SKIPS teardown if it is
 * `active` again — the disable→enable race guard, so a bucket re-enabled after a
 * teardown was queued keeps its (re-)indexed data. The companion bucket itself
 * is left in place (deleteBucket is unsupported on both providers); only its
 * contents are removed. Per-bucket failures are isolated so one bad bucket does
 * not abort the region — the orchestrator backstop retries via the still-present
 * `teardownPendingAt` marker.
 */
async function teardownRegion(args: TeardownRegionArgs): Promise<number> {
  const { orgId, region, tenantId, bucketNames } = args;

  const orchestrator = getOrchestratorForRegion(region);
  const ctx = await orchestrator.getS3ClientContext(tenantId);
  const s3 = createS3Client(ctx);
  // No ensureBucket: teardown never creates a companion (dropIndex tolerates a
  // missing bucket).
  const vectorStore = new BucketObjectVectorStore(s3);

  let tornDown = 0;
  for (const bucketName of bucketNames) {
    try {
      const enablement = await getBucketRagEnablement(orgId, region, bucketName);
      if (enablement?.status === 'active') {
        console.log(`${LOG} Teardown skipped: bucket re-enabled since queued`, {
          region,
          bucketName,
        });
        continue;
      }

      await vectorStore.dropIndex(orgId, region, bucketName);
      await deleteAllManifestEntries(orgId, region, bucketName);
      await clearCheckpoint(orgId, region, bucketName);
      await clearTeardownPending(orgId, region, bucketName);
      tornDown++;
    } catch (error) {
      console.error(`${LOG} Teardown failed, continuing`, {
        orgId,
        orchestrator: orchestrator.id,
        region,
        bucketName,
        error,
      });
    }
  }
  return tornDown;
}
