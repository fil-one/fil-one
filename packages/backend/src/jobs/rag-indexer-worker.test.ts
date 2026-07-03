import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'aws-lambda';
import type { S3ClientContext } from '../lib/s3-client.js';
import type { ProvisionedRegion } from '../lib/region-helpers.js';
import { buildContext } from '../test/lambda-test-utilities.js';
import { S3Region } from '@filone/shared';
import type { RagIndexerWorkerPayload } from './rag-indexer-worker.js';

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
}));

vi.mock('./rag-indexer-helpers.js', () => ({
  indexBucket: mockIndexBucket,
}));

vi.mock('@filone/rag-shared', () => ({
  S3VectorsStore: mockS3VectorsStore,
}));

import { handler } from './rag-indexer-worker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const S3_CTX: S3ClientContext = {
  endpointUrl: 'https://s3.example',
  region: 'eu-west-1',
  credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
  forcePathStyle: true,
};

function makeOrchestrator(id: string, region: S3Region) {
  return {
    id,
    region,
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
    const update = mockUpdateBucketTelemetry.mock.calls[0]?.[2] as Record<string, unknown>;
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
});
