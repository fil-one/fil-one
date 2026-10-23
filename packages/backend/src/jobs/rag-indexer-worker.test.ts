import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'aws-lambda';
import type { S3ClientContext } from '../lib/s3-client.ts';
import type { ProvisionedRegion } from '../lib/region-helpers.ts';
import { buildContext } from '../test/lambda-test-utilities.ts';
import { S3Region } from '@filone/shared';
import { reportMetric, type MetricEvent } from '../lib/metrics.ts';
import type { RagIndexerWorkerPayload } from './rag-indexer-worker.ts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    RagVectorBucket: { name: 'rag-vectors' },
  },
}));

const {
  mockGetProvisionedRegions,
  mockGetOrchestratorForRegion,
  mockCreateS3Client,
  mockIndexBucket,
  mockS3VectorsStore,
  mockUpdateBucketTelemetry,
  fakeS3Client,
} = vi.hoisted(() => ({
  mockGetProvisionedRegions: vi.fn(),
  mockGetOrchestratorForRegion: vi.fn(),
  mockCreateS3Client: vi.fn(),
  mockIndexBucket: vi.fn(),
  mockS3VectorsStore: vi.fn(),
  mockUpdateBucketTelemetry: vi.fn(),
  fakeS3Client: { tag: 's3-client' },
}));

const mockIsOrgDeletedOrDeleting = vi.fn(async (_orgId: string) => false);

vi.mock('../lib/org-profile.ts', () => ({
  isOrgDeletedOrDeleting: (orgId: string) => mockIsOrgDeletedOrDeleting(orgId),
}));

vi.mock('../lib/region-helpers.ts', () => ({
  getProvisionedRegions: mockGetProvisionedRegions,
}));

vi.mock('../lib/service-orchestrator-registry.ts', () => ({
  getOrchestratorForRegion: mockGetOrchestratorForRegion,
}));

vi.mock('../lib/s3-client.ts', () => ({
  createS3Client: mockCreateS3Client,
}));

vi.mock('../lib/bucket-rag-enablement.ts', () => ({
  updateBucketTelemetry: mockUpdateBucketTelemetry,
}));

vi.mock('./rag-indexer-helpers.ts', () => ({
  indexBucket: mockIndexBucket,
}));

vi.mock('@filone/rag-shared', () => ({
  S3VectorsStore: mockS3VectorsStore,
}));

vi.mock('../lib/metrics.ts', () => ({ reportMetric: vi.fn() }));

// Forge regions sync on the Bucket Intelligence engine. The client is faked;
// the real target builder runs.
const engineState = vi.hoisted(() => ({ configured: true }));
const mockEngineSync = vi.fn();
vi.mock('../lib/rag-engine-client.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/rag-engine-client.ts')>(
    '../lib/rag-engine-client.ts',
  );
  return {
    ...actual,
    getRagEngineClient: () => {
      if (!engineState.configured) throw new actual.RagEngineNotConfiguredError();
      return { sync: mockEngineSync };
    },
  };
});

import { handler } from './rag-indexer-worker.ts';

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
    regions: [region],
    getS3ClientContext: vi.fn().mockResolvedValue(S3_CTX),
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
    const match = regions.find((r) => r.orchestrator.regions.includes(region));
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
    mockIsOrgDeletedOrDeleting.mockResolvedValue(false);
    mockCreateS3Client.mockReturnValue(fakeS3Client);
    mockUpdateBucketTelemetry.mockResolvedValue(undefined);
    mockIndexBucket.mockResolvedValue({
      added: 0,
      updated: 0,
      removed: 0,
      failed: 0,
      completed: true,
    });
  });

  // Vectors and manifest rows written now are residue the purge has already
  // swept past, and nothing else collects them.
  it('skips an org that is deleted or being deleted, before resolving regions', async () => {
    mockIsOrgDeletedOrDeleting.mockResolvedValue(true);

    await handler(payload([{ region: S3Region.EuWest1, bucketName: 'b1' }]), AMPLE_CONTEXT);

    expect(mockGetProvisionedRegions).not.toHaveBeenCalled();
    expect(mockIndexBucket).not.toHaveBeenCalled();
  });

  // The invocation runs to a 900s timeout, so the fence can land mid-run. Without
  // a per-bucket re-check, indexBucket calls ensureIndex and recreates an index
  // the teardown already dropped.
  it('stops indexing when the fence lands after the run started', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);
    // False for the up-front check, true by the time the first bucket starts.
    mockIsOrgDeletedOrDeleting.mockResolvedValueOnce(false).mockResolvedValue(true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await handler(
        payload([
          { region: S3Region.EuWest1, bucketName: 'b1' },
          { region: S3Region.EuWest1, bucketName: 'b2' },
        ]),
        AMPLE_CONTEXT,
      );

      expect(mockIndexBucket).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
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

  it('instantiates the vector store from the RAG vector bucket resource', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    useRegions([provisioned(aurora, 'tenant-a')]);

    await handler(payload([{ region: S3Region.EuWest1, bucketName: 'b1' }]), AMPLE_CONTEXT);

    expect(mockS3VectorsStore).toHaveBeenCalledWith('rag-vectors');
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
});

describe('rag-indexer-worker on Forge regions (Bucket Intelligence engine)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engineState.configured = true;
    mockIsOrgDeletedOrDeleting.mockResolvedValue(false);
    mockCreateS3Client.mockReturnValue(fakeS3Client);
    mockUpdateBucketTelemetry.mockResolvedValue(undefined);
    mockEngineSync.mockResolvedValue({ syncState: 'syncing', filesIndexed: 0, indexedBytes: 0 });
    mockIndexBucket.mockResolvedValue({
      added: 1,
      updated: 0,
      removed: 0,
      failed: 0,
      completed: true,
    });
  });

  it('asks the engine to sync each Forge bucket instead of indexing into S3 Vectors', async () => {
    const forge = makeOrchestrator('forge', S3Region.EuCentral3);
    useRegions([provisioned(forge, 'tenant-forge')]);

    await handler(
      payload([
        { region: S3Region.EuCentral3, bucketName: 'docs' },
        { region: S3Region.EuCentral3, bucketName: 'notes' },
      ]),
      AMPLE_CONTEXT,
    );

    expect(mockIndexBucket).not.toHaveBeenCalled();
    expect(mockCreateS3Client).not.toHaveBeenCalled();
    expect(forge.getS3ClientContext).toHaveBeenCalledWith('tenant-forge');
    expect(mockEngineSync.mock.calls.map(([target]) => target)).toStrictEqual([
      {
        orgId: 'org-1',
        region: S3Region.EuCentral3,
        bucketName: 'docs',
        s3: {
          endpointUrl: 'https://s3.example',
          region: 'eu-west-1',
          accessKeyId: 'AK',
          secretAccessKey: 'SK',
        },
      },
      expect.objectContaining({ bucketName: 'notes' }),
    ]);
  });

  it('keeps eu-west-1 and us-east-1 buckets on the S3 Vectors indexer in the same run', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    const fth = makeOrchestrator('fth', S3Region.UsEast1);
    const forgeDev = makeOrchestrator('forgeDev', S3Region.UsEast9);
    useRegions([
      provisioned(aurora, 'tenant-aurora'),
      provisioned(fth, 'tenant-fth'),
      provisioned(forgeDev, 'tenant-forge-dev'),
    ]);

    await handler(
      payload([
        { region: S3Region.EuWest1, bucketName: 'eu' },
        { region: S3Region.UsEast1, bucketName: 'us' },
        { region: S3Region.UsEast9, bucketName: 'forge' },
      ]),
      AMPLE_CONTEXT,
    );

    const indexed = mockIndexBucket.mock.calls.map(([ctx]) => [ctx.region, ctx.bucketName]);
    expect(indexed).toStrictEqual([
      [S3Region.EuWest1, 'eu'],
      [S3Region.UsEast1, 'us'],
    ]);
    expect(mockIndexBucket.mock.calls[0][0].vectorStore).toBeInstanceOf(mockS3VectorsStore);
    expect(mockEngineSync).toHaveBeenCalledTimes(1);
    expect(mockEngineSync.mock.calls[0][0]).toMatchObject({
      region: S3Region.UsEast9,
      bucketName: 'forge',
    });
  });

  it('records a failed sync for a bucket whose engine sync could not start', async () => {
    const forge = makeOrchestrator('forge', S3Region.EuCentral3);
    useRegions([provisioned(forge, 'tenant-forge')]);
    mockEngineSync
      .mockRejectedValueOnce(new Error('engine unreachable'))
      .mockResolvedValueOnce({ syncState: 'syncing' });

    await handler(
      payload([
        { region: S3Region.EuCentral3, bucketName: 'bad' },
        { region: S3Region.EuCentral3, bucketName: 'good' },
      ]),
      AMPLE_CONTEXT,
    );

    expect(mockUpdateBucketTelemetry).toHaveBeenCalledWith('org-1', S3Region.EuCentral3, 'bad', {
      syncState: 'error',
      lastSyncError: 'engine unreachable',
    });
    expect(mockEngineSync).toHaveBeenCalledTimes(2);
  });

  it('starts no further engine syncs once the invocation deadline has passed', async () => {
    const forge = makeOrchestrator('forge', S3Region.EuCentral3);
    useRegions([provisioned(forge, 'tenant-forge')]);
    vi.useFakeTimers({ toFake: ['Date'] });
    // The first sync takes past the deadline (one second after the 60 s headroom).
    mockEngineSync.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 5_000);
      return { syncState: 'syncing' };
    });

    try {
      await handler(
        payload([
          { region: S3Region.EuCentral3, bucketName: 'first' },
          { region: S3Region.EuCentral3, bucketName: 'second' },
        ]),
        contextWithRemaining(61_000),
      );
    } finally {
      vi.useRealTimers();
    }

    expect(mockEngineSync.mock.calls.map(([target]) => target.bucketName)).toStrictEqual(['first']);
  });

  it('starts engine syncs before an S3 Vectors backfill uses up the budget', async () => {
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    const forge = makeOrchestrator('forge', S3Region.EuCentral3);
    useRegions([provisioned(aurora, 'tenant-aurora'), provisioned(forge, 'tenant-forge')]);
    vi.useFakeTimers({ toFake: ['Date'] });
    // The eu-west-1 backfill works right up to the deadline, then checkpoints.
    mockIndexBucket.mockImplementationOnce(async (_ctx, options) => {
      vi.setSystemTime(options.deadlineEpochMs);
      return { added: 0, updated: 0, removed: 0, failed: 0, completed: false };
    });

    try {
      await handler(
        payload([
          { region: S3Region.EuWest1, bucketName: 'backfill' },
          { region: S3Region.EuCentral3, bucketName: 'forge' },
        ]),
        contextWithRemaining(15 * 60 * 1000),
      );
    } finally {
      vi.useRealTimers();
    }

    expect(mockIndexBucket).toHaveBeenCalledOnce();
    expect(mockEngineSync.mock.calls.map(([target]) => target.bucketName)).toStrictEqual(['forge']);
  });

  it('fails only the Forge region when the stage has no engine', async () => {
    engineState.configured = false;
    const aurora = makeOrchestrator('aurora', S3Region.EuWest1);
    const forge = makeOrchestrator('forge', S3Region.EuCentral3);
    useRegions([provisioned(aurora, 'tenant-aurora'), provisioned(forge, 'tenant-forge')]);

    await handler(
      payload([
        { region: S3Region.EuCentral3, bucketName: 'forge' },
        { region: S3Region.EuWest1, bucketName: 'eu' },
      ]),
      AMPLE_CONTEXT,
    );

    expect(mockIndexBucket).toHaveBeenCalledTimes(1);
    expect(mockIndexBucket.mock.calls[0][0].bucketName).toBe('eu');
  });
});
