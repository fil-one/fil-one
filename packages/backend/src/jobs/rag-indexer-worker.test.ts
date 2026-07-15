import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'aws-lambda';
import type { S3ClientContext } from '../lib/s3-client.js';
import type { ProvisionedRegion } from '../lib/region-helpers.js';
import { buildContext } from '../test/lambda-test-utilities.js';
import { S3Region } from '@filone/shared';
import { reportMetric, type MetricEvent } from '../lib/metrics.js';
import { BucketAlreadyExistsError } from '../lib/errors.js';
import type { RagIndexerWorkerPayload } from './rag-indexer-worker.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const {
  mockGetProvisionedRegions,
  mockGetOrchestratorForRegion,
  mockCreateS3Client,
  mockIndexBucket,
  mockBucketObjectVectorStore,
  mockDropIndex,
  mockUpdateBucketTelemetry,
  mockGetBucketRagEnablement,
  mockClearTeardownPending,
  mockClearCheckpoint,
  mockDeleteAllManifestEntries,
  fakeS3Client,
} = vi.hoisted(() => ({
  mockGetProvisionedRegions: vi.fn(),
  mockGetOrchestratorForRegion: vi.fn(),
  mockCreateS3Client: vi.fn(),
  mockIndexBucket: vi.fn(),
  mockBucketObjectVectorStore: vi.fn(),
  mockDropIndex: vi.fn(),
  mockUpdateBucketTelemetry: vi.fn(),
  mockGetBucketRagEnablement: vi.fn(),
  mockClearTeardownPending: vi.fn(),
  mockClearCheckpoint: vi.fn(),
  mockDeleteAllManifestEntries: vi.fn(),
  fakeS3Client: { tag: 's3-client' },
}));

vi.mock('../lib/region-helpers.js', () => ({
  getProvisionedRegions: mockGetProvisionedRegions,
}));

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: mockGetOrchestratorForRegion,
}));

vi.mock('../lib/s3-client.js', () => ({
  createS3Client: mockCreateS3Client,
}));

vi.mock('../lib/bucket-rag-enablement.js', () => ({
  updateBucketTelemetry: mockUpdateBucketTelemetry,
  getBucketRagEnablement: mockGetBucketRagEnablement,
  clearTeardownPending: mockClearTeardownPending,
}));

vi.mock('./rag-indexer-helpers.js', () => ({
  indexBucket: mockIndexBucket,
}));

vi.mock('./rag-indexer-manifest.js', () => ({
  clearCheckpoint: mockClearCheckpoint,
  deleteAllManifestEntries: mockDeleteAllManifestEntries,
}));

vi.mock('@filone/rag-shared', () => ({
  BucketObjectVectorStore: mockBucketObjectVectorStore,
}));

vi.mock('../lib/metrics.js', () => ({ reportMetric: vi.fn() }));

import { handler } from './rag-indexer-worker.js';

const reportMetricMock = vi.mocked(reportMetric);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const S3_CTX: S3ClientContext = {
  endpointUrl: 'https://s3.example',
  region: 'eu-west-1',
  credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
  forcePathStyle: true,
  orchestratorId: 'test',
  tenantId: 't-1',
};

function makeOrchestrator(id: string, region: S3Region) {
  return {
    id,
    region,
    getS3ClientContext: vi.fn().mockResolvedValue(S3_CTX),
    createBucket: vi.fn().mockResolvedValue(undefined),
  };
}

function provisioned(orchestrator: ReturnType<typeof makeOrchestrator>, tenantId: string) {
  return { orchestrator, tenantId } as unknown as ProvisionedRegion;
}

/**
 * Wire both region mocks from one provisioned-region list: `getProvisionedRegions`
 * returns them (so the worker can resolve each region's tenant), and
 * `getOrchestratorForRegion` resolves a region back to its orchestrator (used to
 * build that region's S3 client). In these tests the two are the same object.
 */
function useRegions(regions: ProvisionedRegion[]) {
  mockGetProvisionedRegions.mockResolvedValue(regions);
  mockGetOrchestratorForRegion.mockImplementation((region: S3Region) => {
    const match = regions.find((r) => r.orchestrator.region === region);
    if (!match) throw new Error(`no orchestrator registered for region ${region}`);
    return match.orchestrator;
  });
}

/** A Lambda context reporting `remainingMs` until the hard timeout. */
function contextWithRemaining(remainingMs: number): Context {
  return buildContext({ getRemainingTimeInMillis: () => remainingMs });
}

/** Plenty of remaining time so no early deadline is imposed during a test. */
const AMPLE_CONTEXT = contextWithRemaining(15 * 60 * 1000);

function payload(buckets: RagIndexerWorkerPayload['buckets']): RagIndexerWorkerPayload {
  return { orgId: 'org-1', buckets };
}

/** Every metric event emitted so far, in emission order. */
const reportedMetrics = (): MetricEvent[] => reportMetricMock.mock.calls.map(([e]) => e);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rag-indexer-worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateS3Client.mockReturnValue(fakeS3Client);
    mockUpdateBucketTelemetry.mockResolvedValue(undefined);
    mockIndexBucket.mockResolvedValue({
      added: 0,
      updated: 0,
      removed: 0,
      failed: 0,
      completed: true,
    });
    // `new BucketObjectVectorStore(...)` yields an instance exposing dropIndex.
    // A regular function (not an arrow) is required so it is constructable.
    mockBucketObjectVectorStore.mockImplementation(function () {
      return { dropIndex: mockDropIndex };
    });
    mockDropIndex.mockResolvedValue(undefined);
    mockClearCheckpoint.mockResolvedValue(undefined);
    mockClearTeardownPending.mockResolvedValue(undefined);
    mockDeleteAllManifestEntries.mockResolvedValue(undefined);
    // Default: a disabled row (teardown proceeds). Re-enabled tests override.
    mockGetBucketRagEnablement.mockResolvedValue({ status: 'disabled' });
  });

  it('skips when the org is not provisioned in any region', async () => {
    mockGetProvisionedRegions.mockResolvedValue([]);

    await handler(payload([{ region: S3Region.EuWest1, bucketName: 'b1' }]), AMPLE_CONTEXT);

    expect(mockCreateS3Client).not.toHaveBeenCalled();
    expect(mockIndexBucket).not.toHaveBeenCalled();
  });

  it('builds an S3 client from the orchestrator context for the bucket region', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);

    await handler(payload([{ region: S3Region.EuWest1, bucketName: 'b1' }]), AMPLE_CONTEXT);

    expect(mockGetProvisionedRegions).toHaveBeenCalledWith('org-1');
    expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith(S3Region.EuWest1);
    expect(aurora.getS3ClientContext).toHaveBeenCalledWith('tenant-a');
    expect(mockCreateS3Client).toHaveBeenCalledWith(S3_CTX);
  });

  it('indexes the buckets named in the payload', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);

    await handler(payload([{ region: S3Region.EuWest1, bucketName: 'b1' }]), AMPLE_CONTEXT);

    expect(mockIndexBucket).toHaveBeenCalledOnce();
    expect(mockIndexBucket).toHaveBeenCalledWith(
      {
        orgId: 'org-1',
        s3: fakeS3Client,
        region: S3Region.EuWest1,
        bucketName: 'b1',
        vectorStore: expect.anything(),
      },
      expect.objectContaining({ deadlineEpochMs: expect.any(Number) }),
    );
  });

  it('indexes across multiple regions, each via its own orchestrator credentials', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    const fth = makeOrchestrator('fth', S3Region.UsEast1);
    useRegions([provisioned(aurora, 'tenant-a'), provisioned(fth, 'tenant-f')]);

    await handler(
      payload([
        { region: S3Region.EuWest1, bucketName: 'b1' },
        { region: S3Region.UsEast1, bucketName: 'b2' },
      ]),
      AMPLE_CONTEXT,
    );

    expect(mockIndexBucket).toHaveBeenCalledTimes(2);
    expect(aurora.getS3ClientContext).toHaveBeenCalledWith('tenant-a');
    expect(fth.getS3ClientContext).toHaveBeenCalledWith('tenant-f');
  });

  it('skips a bucket whose region is not provisioned for the org', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);

    // Payload targets us-east-1, but the org is only provisioned in eu-west-1.
    await handler(payload([{ region: S3Region.UsEast1, bucketName: 'b2' }]), AMPLE_CONTEXT);

    expect(mockGetOrchestratorForRegion).not.toHaveBeenCalled();
    expect(mockCreateS3Client).not.toHaveBeenCalled();
    expect(mockIndexBucket).not.toHaveBeenCalled();
  });

  it('isolates a region failure: other regions still index', async () => {
    const failing = makeOrchestrator('aurora', S3Region.EuWest1);
    failing.getS3ClientContext.mockRejectedValue(new Error('creds unavailable'));
    const healthy = makeOrchestrator('fth', S3Region.UsEast1);
    useRegions([provisioned(failing, 'tenant-a'), provisioned(healthy, 'tenant-f')]);

    await handler(
      payload([
        { region: S3Region.EuWest1, bucketName: 'b1' },
        { region: S3Region.UsEast1, bucketName: 'b2' },
      ]),
      AMPLE_CONTEXT,
    );

    expect(mockIndexBucket).toHaveBeenCalledOnce();
    expect(mockIndexBucket).toHaveBeenCalledWith(
      {
        orgId: 'org-1',
        s3: fakeS3Client,
        region: S3Region.UsEast1,
        bucketName: 'b2',
        vectorStore: expect.anything(),
      },
      expect.anything(),
    );
  });

  it('isolates a per-bucket failure: other buckets in the region still index', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);
    mockIndexBucket
      .mockRejectedValueOnce(new Error('index failed'))
      .mockResolvedValue({ added: 0, updated: 0, removed: 0, failed: 0, completed: true });

    await handler(
      payload([
        { region: S3Region.EuWest1, bucketName: 'b1' },
        { region: S3Region.EuWest1, bucketName: 'b2' },
      ]),
      AMPLE_CONTEXT,
    );

    expect(mockIndexBucket).toHaveBeenCalledTimes(2);
  });

  it('persists error telemetry (syncState + message, never the enablement status) when a bucket fails', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);
    mockIndexBucket.mockRejectedValue(new Error('index exploded'));

    await handler(payload([{ region: S3Region.EuWest1, bucketName: 'b1' }]), AMPLE_CONTEXT);

    expect(mockUpdateBucketTelemetry).toHaveBeenCalledWith('org-1', S3Region.EuWest1, 'b1', {
      syncState: 'error',
      lastSyncError: 'index exploded',
    });
    // The failure path records sync state only — it must not flip enablement off.
    const update = mockUpdateBucketTelemetry.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(update).not.toHaveProperty('status');
  });

  it('does not mask the original failure if writing error telemetry also fails', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);
    mockIndexBucket
      .mockRejectedValueOnce(new Error('index failed'))
      .mockResolvedValue({ added: 0, updated: 0, removed: 0, failed: 0, completed: true });
    mockUpdateBucketTelemetry.mockRejectedValueOnce(new Error('telemetry write failed'));

    // The region must still finish indexing the healthy bucket.
    await handler(
      payload([
        { region: S3Region.EuWest1, bucketName: 'b1' },
        { region: S3Region.EuWest1, bucketName: 'b2' },
      ]),
      AMPLE_CONTEXT,
    );

    expect(mockIndexBucket).toHaveBeenCalledTimes(2);
  });

  it('builds the companion store per region on the tenant S3 client with an ensureBucket callback', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);

    await handler(payload([{ region: S3Region.EuWest1, bucketName: 'b1' }]), AMPLE_CONTEXT);

    expect(mockBucketObjectVectorStore).toHaveBeenCalledWith(
      fakeS3Client,
      expect.objectContaining({ ensureBucket: expect.any(Function) }),
    );
  });

  it('ensureBucket provisions the companion via the orchestrator and swallows BucketAlreadyExistsError', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);

    await handler(payload([{ region: S3Region.EuWest1, bucketName: 'b1' }]), AMPLE_CONTEXT);
    const ensureBucket = mockBucketObjectVectorStore.mock.calls[0][1].ensureBucket as (
      name: string,
    ) => Promise<void>;

    // Normal provisioning goes through the region's orchestrator + tenant.
    await ensureBucket('filone-rag-companion');
    expect(aurora.createBucket).toHaveBeenCalledWith('tenant-a', {
      bucketName: 'filone-rag-companion',
    });

    // An already-existing companion is the idempotent steady state (swallowed);
    // any other failure (e.g. quota) propagates.
    aurora.createBucket.mockRejectedValueOnce(new BucketAlreadyExistsError('filone-rag-companion'));
    await expect(ensureBucket('filone-rag-companion')).resolves.toBeUndefined();

    aurora.createBucket.mockRejectedValueOnce(new Error('bucketLimit exceeded'));
    await expect(ensureBucket('filone-rag-companion')).rejects.toThrow('bucketLimit exceeded');
  });

  // -----------------------------------------------------------------------
  // Deadline derived from the Lambda context (AC#8)
  // -----------------------------------------------------------------------

  it('derives the deadline from the Lambda context remaining time, leaving headroom', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);

    // 5 minutes left in the invocation; the worker reserves ~60s of headroom.
    const remainingMs = 5 * 60 * 1000;
    const before = Date.now();
    await handler(
      payload([{ region: S3Region.EuWest1, bucketName: 'b1' }]),
      contextWithRemaining(remainingMs),
    );
    const after = Date.now();

    expect(mockIndexBucket).toHaveBeenCalledOnce();
    const deadlineEpochMs = mockIndexBucket.mock.calls[0][1].deadlineEpochMs as number;
    // Deadline = now + (remaining - 60s headroom). It must be a real, finite,
    // future deadline (not Infinity) and strictly earlier than the hard timeout.
    expect(Number.isFinite(deadlineEpochMs)).toBe(true);
    expect(deadlineEpochMs).toBeGreaterThanOrEqual(before + remainingMs - 60_000);
    expect(deadlineEpochMs).toBeLessThanOrEqual(after + remainingMs - 60_000);
    expect(deadlineEpochMs).toBeLessThan(before + remainingMs);
  });

  it('falls back to no early deadline when remaining time is below the headroom', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);

    // Less remaining than the headroom buffer: no meaningful early deadline.
    await handler(
      payload([{ region: S3Region.EuWest1, bucketName: 'b1' }]),
      contextWithRemaining(10_000),
    );

    expect(mockIndexBucket).toHaveBeenCalledOnce();
    const deadlineEpochMs = mockIndexBucket.mock.calls[0][1].deadlineEpochMs as number;
    expect(deadlineEpochMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('reads the remaining time from context.getRemainingTimeInMillis (production path)', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);

    const getRemainingTimeInMillis = vi.fn().mockReturnValue(5 * 60 * 1000);
    const ctx = buildContext({ getRemainingTimeInMillis });

    // No injected override -> the handler must consult the Lambda context.
    await handler(payload([{ region: S3Region.EuWest1, bucketName: 'b1' }]), ctx);

    expect(getRemainingTimeInMillis).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // CloudWatch metrics emission
  // -----------------------------------------------------------------------

  it('emits per-region metrics aggregating bucket and object counts for a clean run', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);
    mockIndexBucket.mockResolvedValue({
      added: 2,
      updated: 1,
      removed: 0,
      failed: 1,
      completed: true,
    });

    await handler(
      payload([
        { region: S3Region.EuWest1, bucketName: 'b1' },
        { region: S3Region.EuWest1, bucketName: 'b2' },
      ]),
      AMPLE_CONTEXT,
    );

    const regionEvent = reportedMetrics().find((e) => e.region === S3Region.EuWest1);
    expect(regionEvent).toBeDefined();
    expect(regionEvent).toMatchObject({
      _aws: {
        CloudWatchMetrics: [{ Namespace: 'FilOne', Dimensions: [['region']] }],
      },
      region: S3Region.EuWest1,
      RagIndexerBucketsIndexed: 2,
      RagIndexerBucketFailures: 0,
      RagIndexerObjectsAdded: 4,
      RagIndexerObjectsUpdated: 2,
      RagIndexerObjectsRemoved: 0,
      RagIndexerObjectsFailed: 2,
    });
  });

  it('counts a failed bucket under RagIndexerBucketFailures, the rest as indexed', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);
    mockIndexBucket
      .mockRejectedValueOnce(new Error('index failed'))
      .mockResolvedValue({ added: 3, updated: 0, removed: 0, failed: 0, completed: true });

    await handler(
      payload([
        { region: S3Region.EuWest1, bucketName: 'b1' },
        { region: S3Region.EuWest1, bucketName: 'b2' },
      ]),
      AMPLE_CONTEXT,
    );

    const regionEvent = reportedMetrics().find((e) => e.region === S3Region.EuWest1);
    expect(regionEvent).toMatchObject({
      RagIndexerBucketsIndexed: 1,
      RagIndexerBucketFailures: 1,
      RagIndexerObjectsAdded: 3,
    });
  });

  it('counts a checkpointed (incomplete) bucket separately, not as indexed, while still counting its objects', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);
    // b1 hit the deadline and checkpointed mid-way; b2 fully reconciled.
    mockIndexBucket
      .mockResolvedValueOnce({ added: 5, updated: 0, removed: 0, failed: 0, completed: false })
      .mockResolvedValue({ added: 1, updated: 0, removed: 0, failed: 0, completed: true });

    await handler(
      payload([
        { region: S3Region.EuWest1, bucketName: 'b1' },
        { region: S3Region.EuWest1, bucketName: 'b2' },
      ]),
      AMPLE_CONTEXT,
    );

    const regionEvent = reportedMetrics().find((e) => e.region === S3Region.EuWest1);
    expect(regionEvent).toMatchObject({
      // Only the fully reconciled bucket counts as indexed.
      RagIndexerBucketsIndexed: 1,
      RagIndexerBucketsCheckpointed: 1,
      RagIndexerBucketFailures: 0,
      // Objects added this run include the checkpointed bucket's work (5 + 1).
      RagIndexerObjectsAdded: 6,
    });
  });

  it('reports all of a failed region as bucket failures with nothing indexed', async () => {
    const failing = makeOrchestrator('aurora', S3Region.EuWest1);
    failing.getS3ClientContext.mockRejectedValue(new Error('creds unavailable'));
    useRegions([provisioned(failing, 'tenant-a')]);

    await handler(
      payload([
        { region: S3Region.EuWest1, bucketName: 'b1' },
        { region: S3Region.EuWest1, bucketName: 'b2' },
      ]),
      AMPLE_CONTEXT,
    );

    const regionEvent = reportedMetrics().find((e) => e.region === S3Region.EuWest1);
    expect(regionEvent).toMatchObject({
      RagIndexerBucketsIndexed: 0,
      RagIndexerBucketFailures: 2,
    });
  });

  it('emits a worker-invocation success metric with duration and region tally', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    const fth = makeOrchestrator('fth', S3Region.UsEast1);
    useRegions([provisioned(aurora, 'tenant-a'), provisioned(fth, 'tenant-f')]);

    await handler(
      payload([
        { region: S3Region.EuWest1, bucketName: 'b1' },
        { region: S3Region.UsEast1, bucketName: 'b2' },
      ]),
      AMPLE_CONTEXT,
    );

    const invocationEvent = reportedMetrics().find(
      (e) => e.RagIndexerWorkerInvocationSuccess !== undefined,
    );
    expect(invocationEvent).toBeDefined();
    expect(invocationEvent).toMatchObject({
      _aws: {
        CloudWatchMetrics: [{ Namespace: 'FilOne', Dimensions: [[]] }],
      },
      RagIndexerWorkerInvocationSuccess: 1,
      RagIndexerWorkerDuration: expect.any(Number),
      RagIndexerRegionsProcessed: 2,
      RagIndexerRegionFailures: 0,
    });
  });

  it('emits a worker-invocation failure metric and rethrows when the handler throws', async () => {
    mockGetProvisionedRegions.mockRejectedValue(new Error('region lookup failed'));

    await expect(
      handler(payload([{ region: S3Region.EuWest1, bucketName: 'b1' }]), AMPLE_CONTEXT),
    ).rejects.toThrow('region lookup failed');

    const invocationEvent = reportedMetrics().find(
      (e) => e.RagIndexerWorkerInvocationFailure !== undefined,
    );
    expect(invocationEvent).toBeDefined();
    expect(invocationEvent).toMatchObject({
      _aws: {
        CloudWatchMetrics: [{ Namespace: 'FilOne', Dimensions: [[]] }],
      },
      RagIndexerWorkerInvocationFailure: 1,
      RagIndexerWorkerDuration: expect.any(Number),
    });
  });

  // -----------------------------------------------------------------------
  // Teardown mode
  // -----------------------------------------------------------------------

  function teardownPayload(buckets: RagIndexerWorkerPayload['buckets']): RagIndexerWorkerPayload {
    return { orgId: 'org-1', buckets, mode: 'teardown' };
  }

  it('tears down a disabled bucket: drops the index, manifest, checkpoint, and marker', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);

    await handler(teardownPayload([{ region: S3Region.EuWest1, bucketName: 'b1' }]), AMPLE_CONTEXT);

    expect(mockIndexBucket).not.toHaveBeenCalled();
    expect(mockDropIndex).toHaveBeenCalledWith('org-1', S3Region.EuWest1, 'b1');
    expect(mockDeleteAllManifestEntries).toHaveBeenCalledWith('org-1', S3Region.EuWest1, 'b1');
    expect(mockClearCheckpoint).toHaveBeenCalledWith('org-1', S3Region.EuWest1, 'b1');
    expect(mockClearTeardownPending).toHaveBeenCalledWith('org-1', S3Region.EuWest1, 'b1');
  });

  it('emits no per-region index metrics for a teardown run', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);

    await handler(teardownPayload([{ region: S3Region.EuWest1, bucketName: 'b1' }]), AMPLE_CONTEXT);

    // Zeroed index counts would read as an idle indexer rather than a teardown.
    expect(reportedMetrics().find((e) => e.region === S3Region.EuWest1)).toBeUndefined();
    // The invocation metric still fires, so the run-count series stays complete.
    expect(
      reportedMetrics().find((e) => e.RagIndexerWorkerInvocationSuccess !== undefined),
    ).toBeDefined();
  });

  it('skips teardown when the bucket has been re-enabled (disable→enable race guard)', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);
    mockGetBucketRagEnablement.mockResolvedValue({ status: 'active' });

    await handler(teardownPayload([{ region: S3Region.EuWest1, bucketName: 'b1' }]), AMPLE_CONTEXT);

    expect(mockDropIndex).not.toHaveBeenCalled();
    expect(mockDeleteAllManifestEntries).not.toHaveBeenCalled();
    expect(mockClearTeardownPending).not.toHaveBeenCalled();
  });

  it('isolates a per-bucket teardown failure: other buckets still tear down', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);
    mockDropIndex.mockRejectedValueOnce(new Error('drop failed')).mockResolvedValue(undefined);

    await handler(
      teardownPayload([
        { region: S3Region.EuWest1, bucketName: 'b1' },
        { region: S3Region.EuWest1, bucketName: 'b2' },
      ]),
      AMPLE_CONTEXT,
    );

    expect(mockDropIndex).toHaveBeenCalledTimes(2);
    // The healthy bucket still completed its full teardown.
    expect(mockClearTeardownPending).toHaveBeenCalledWith('org-1', S3Region.EuWest1, 'b2');
  });
});
