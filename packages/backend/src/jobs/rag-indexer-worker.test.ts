import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { Context } from 'aws-lambda';
import type { S3ClientContext } from '../lib/s3-client.js';
import type { ProvisionedRegion } from '../lib/region-helpers.js';
import { buildContext } from '../test/lambda-test-utilities.js';
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
  mockCreateS3Client,
  mockIndexBucket,
  mockS3VectorsStore,
  fakeS3Client,
} = vi.hoisted(() => ({
  mockGetProvisionedRegions: vi.fn(),
  mockCreateS3Client: vi.fn(),
  mockIndexBucket: vi.fn(),
  mockS3VectorsStore: vi.fn(),
  fakeS3Client: { tag: 's3-client' },
}));

vi.mock('../lib/region-helpers.js', () => ({
  getProvisionedRegions: mockGetProvisionedRegions,
}));

vi.mock('../lib/s3-client.js', () => ({
  createS3Client: mockCreateS3Client,
}));

vi.mock('./rag-indexer-helpers.js', () => ({
  indexBucket: mockIndexBucket,
}));

vi.mock('@filone/rag-shared', () => ({
  S3VectorsStore: mockS3VectorsStore,
}));

const ddbMock = mockClient(DynamoDBClient);

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

function makeOrchestrator(id: string, bucketNames: string[]) {
  return {
    id,
    region: 'eu-west-1',
    getS3ClientContext: vi.fn().mockResolvedValue(S3_CTX),
    listBuckets: vi.fn().mockResolvedValue(
      bucketNames.map((bucketName) => ({
        bucketName,
        region: 'eu-west-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        isPublic: false,
        versioning: false,
        encrypted: false,
      })),
    ),
  };
}

function region(orchestrator: ReturnType<typeof makeOrchestrator>, tenantId: string) {
  return { orchestrator, tenantId } as unknown as ProvisionedRegion;
}

function mockRagEnabled(bucketIds: string[], status = 'active') {
  ddbMock.on(GetItemCommand).callsFake((input) => {
    const bucketId = (input.Key.pk.S as string).replace('BUCKET#', '');
    if (bucketIds.includes(bucketId)) {
      return { Item: marshall({ pk: input.Key.pk.S, sk: 'RAG', orgId: 'org-1', status }) };
    }
    return { Item: undefined };
  });
}

const payload: RagIndexerWorkerPayload = { orgId: 'org-1' };

/** A Lambda context reporting `remainingMs` until the hard timeout. */
function contextWithRemaining(remainingMs: number): Context {
  return buildContext({ getRemainingTimeInMillis: () => remainingMs });
}

/** Plenty of remaining time so no early deadline is imposed during a test. */
const AMPLE_CONTEXT = contextWithRemaining(15 * 60 * 1000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rag-indexer-worker', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    mockCreateS3Client.mockReturnValue(fakeS3Client);
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

    await handler(payload, AMPLE_CONTEXT);

    expect(mockCreateS3Client).not.toHaveBeenCalled();
    expect(mockIndexBucket).not.toHaveBeenCalled();
  });

  it('resolves regions via getProvisionedRegions and builds an S3 client from the orchestrator context', async () => {
    const orch = makeOrchestrator('aurora', ['b1']);
    mockGetProvisionedRegions.mockResolvedValue([region(orch, 'tenant-a')]);
    mockRagEnabled(['b1']);

    await handler(payload, AMPLE_CONTEXT);

    expect(mockGetProvisionedRegions).toHaveBeenCalledWith('org-1');
    expect(orch.getS3ClientContext).toHaveBeenCalledWith('tenant-a');
    expect(mockCreateS3Client).toHaveBeenCalledWith(S3_CTX);
  });

  it('enumerates buckets via orchestrator.listBuckets and indexes RAG-enabled ones', async () => {
    const orch = makeOrchestrator('aurora', ['b1', 'b2']);
    mockGetProvisionedRegions.mockResolvedValue([region(orch, 'tenant-a')]);
    // Only b1 has RAG enabled; b2 must be skipped.
    mockRagEnabled(['b1']);

    await handler(payload, AMPLE_CONTEXT);

    expect(orch.listBuckets).toHaveBeenCalledWith('tenant-a');
    expect(mockIndexBucket).toHaveBeenCalledOnce();
    expect(mockIndexBucket).toHaveBeenCalledWith(
      fakeS3Client,
      'b1',
      'b1',
      expect.anything(),
      expect.objectContaining({ deadlineEpochMs: expect.any(Number) }),
    );
  });

  it('skips buckets whose RAG status is not active', async () => {
    const orch = makeOrchestrator('aurora', ['b1']);
    mockGetProvisionedRegions.mockResolvedValue([region(orch, 'tenant-a')]);
    mockRagEnabled(['b1'], 'paused');

    await handler(payload, AMPLE_CONTEXT);

    expect(mockIndexBucket).not.toHaveBeenCalled();
  });

  it('honours an explicit bucketIds filter', async () => {
    const orch = makeOrchestrator('aurora', ['b1', 'b2']);
    mockGetProvisionedRegions.mockResolvedValue([region(orch, 'tenant-a')]);
    mockRagEnabled(['b1', 'b2']);

    await handler({ orgId: 'org-1', bucketIds: ['b2'] }, AMPLE_CONTEXT);

    expect(mockIndexBucket).toHaveBeenCalledOnce();
    expect(mockIndexBucket).toHaveBeenCalledWith(
      fakeS3Client,
      'b2',
      'b2',
      expect.anything(),
      expect.anything(),
    );
  });

  it('indexes across multiple regions', async () => {
    const aurora = makeOrchestrator('aurora', ['b1']);
    const fth = makeOrchestrator('fth', ['b2']);
    mockGetProvisionedRegions.mockResolvedValue([
      region(aurora, 'tenant-a'),
      region(fth, 'tenant-f'),
    ]);
    mockRagEnabled(['b1', 'b2']);

    await handler(payload, AMPLE_CONTEXT);

    expect(mockIndexBucket).toHaveBeenCalledTimes(2);
    expect(aurora.listBuckets).toHaveBeenCalledWith('tenant-a');
    expect(fth.listBuckets).toHaveBeenCalledWith('tenant-f');
  });

  it('isolates a region failure: other regions still index', async () => {
    const failing = makeOrchestrator('aurora', ['b1']);
    failing.getS3ClientContext.mockRejectedValue(new Error('creds unavailable'));
    const healthy = makeOrchestrator('fth', ['b2']);
    mockGetProvisionedRegions.mockResolvedValue([
      region(failing, 'tenant-a'),
      region(healthy, 'tenant-f'),
    ]);
    mockRagEnabled(['b1', 'b2']);

    await handler(payload, AMPLE_CONTEXT);

    expect(mockIndexBucket).toHaveBeenCalledOnce();
    expect(mockIndexBucket).toHaveBeenCalledWith(
      fakeS3Client,
      'b2',
      'b2',
      expect.anything(),
      expect.anything(),
    );
  });

  it('isolates a per-bucket failure: other buckets in the region still index', async () => {
    const orch = makeOrchestrator('aurora', ['b1', 'b2']);
    mockGetProvisionedRegions.mockResolvedValue([region(orch, 'tenant-a')]);
    mockRagEnabled(['b1', 'b2']);
    mockIndexBucket
      .mockRejectedValueOnce(new Error('index failed'))
      .mockResolvedValue({ added: 0, updated: 0, removed: 0, failed: 0, completed: true });

    await handler(payload, AMPLE_CONTEXT);

    expect(mockIndexBucket).toHaveBeenCalledTimes(2);
  });

  it('instantiates the vector store from the RAG vector bucket resource', async () => {
    const orch = makeOrchestrator('aurora', ['b1']);
    mockGetProvisionedRegions.mockResolvedValue([region(orch, 'tenant-a')]);
    mockRagEnabled(['b1']);

    await handler(payload, AMPLE_CONTEXT);

    expect(mockS3VectorsStore).toHaveBeenCalledWith('rag-vectors');
  });

  // -----------------------------------------------------------------------
  // Deadline derived from the Lambda context (AC#8)
  // -----------------------------------------------------------------------

  it('derives the deadline from the Lambda context remaining time, leaving headroom', async () => {
    const orch = makeOrchestrator('aurora', ['b1']);
    mockGetProvisionedRegions.mockResolvedValue([region(orch, 'tenant-a')]);
    mockRagEnabled(['b1']);

    // 5 minutes left in the invocation; the worker reserves ~60s of headroom.
    const remainingMs = 5 * 60 * 1000;
    const before = Date.now();
    await handler(payload, contextWithRemaining(remainingMs));
    const after = Date.now();

    expect(mockIndexBucket).toHaveBeenCalledOnce();
    const deadlineEpochMs = mockIndexBucket.mock.calls[0][4].deadlineEpochMs as number;
    // Deadline = now + (remaining - 60s headroom). It must be a real, finite,
    // future deadline (not Infinity) and strictly earlier than the hard timeout.
    expect(Number.isFinite(deadlineEpochMs)).toBe(true);
    expect(deadlineEpochMs).toBeGreaterThanOrEqual(before + remainingMs - 60_000);
    expect(deadlineEpochMs).toBeLessThanOrEqual(after + remainingMs - 60_000);
    expect(deadlineEpochMs).toBeLessThan(before + remainingMs);
  });

  it('falls back to no early deadline when remaining time is below the headroom', async () => {
    const orch = makeOrchestrator('aurora', ['b1']);
    mockGetProvisionedRegions.mockResolvedValue([region(orch, 'tenant-a')]);
    mockRagEnabled(['b1']);

    // Less remaining than the headroom buffer: no meaningful early deadline.
    await handler(payload, contextWithRemaining(10_000));

    expect(mockIndexBucket).toHaveBeenCalledOnce();
    const deadlineEpochMs = mockIndexBucket.mock.calls[0][4].deadlineEpochMs as number;
    expect(deadlineEpochMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('reads the remaining time from context.getRemainingTimeInMillis (production path)', async () => {
    const orch = makeOrchestrator('aurora', ['b1']);
    mockGetProvisionedRegions.mockResolvedValue([region(orch, 'tenant-a')]);
    mockRagEnabled(['b1']);

    const getRemainingTimeInMillis = vi.fn().mockReturnValue(5 * 60 * 1000);
    const ctx = buildContext({ getRemainingTimeInMillis });

    // No injected override -> the handler must consult the Lambda context.
    await handler(payload, ctx);

    expect(getRemainingTimeInMillis).toHaveBeenCalled();
  });
});
