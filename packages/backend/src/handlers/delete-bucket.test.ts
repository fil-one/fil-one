import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoSuchBucket } from '@aws-sdk/client-s3';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const presignerContext = {
  endpointUrl: 'https://s3.dev.aur.lu',
  region: 'auto',
  credentials: { accessKeyId: 'AKIA_CONSOLE', secretAccessKey: 's3_secret' },
  forcePathStyle: true,
};

const mockIsTenantReady = vi.fn();
const mockGetPresignerContext = vi.fn();
const mockOrchestratorDeleteBucket = vi.fn();

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  isTenantReady: (...args: unknown[]) => mockIsTenantReady(...args),
  getPresignerContext: (...args: unknown[]) => mockGetPresignerContext(...args),
  deleteBucket: (...args: unknown[]) => mockOrchestratorDeleteBucket(...args),
};

vi.mock('../lib/service-orchestrator/registry.js', () => ({
  orchestratorForRegion: () => mockOrchestrator,
}));

const mockListObjects = vi.fn();
vi.mock('../lib/service-orchestrator/s3-presigner.js', () => ({
  listObjects: (...args: unknown[]) => mockListObjects(...args),
}));

process.env.FILONE_STAGE = 'test';

import { baseHandler } from './delete-bucket.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('delete-bucket baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTenantReady.mockResolvedValue({ tenantId: 'aurora-t-1' });
    mockGetPresignerContext.mockResolvedValue(presignerContext);
  });

  it('returns 204 after deleting an empty bucket', async () => {
    mockListObjects.mockResolvedValue({ objects: [], isTruncated: false });
    mockOrchestratorDeleteBucket.mockResolvedValue(undefined);

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(204);
    expect(mockOrchestratorDeleteBucket).toHaveBeenCalledWith('aurora-t-1', 'my-bucket');
  });

  it('returns 404 when S3 throws NoSuchBucket', async () => {
    mockListObjects.mockRejectedValue(
      new NoSuchBucket({ message: 'The specified bucket does not exist', $metadata: {} }),
    );

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'no-such-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({ message: 'Bucket not found' });
  });

  it('returns 400 when bucket name is missing from path', async () => {
    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 409 when bucket contains objects', async () => {
    mockListObjects.mockResolvedValue({
      objects: [{ key: 'file.txt', sizeBytes: 100, lastModified: '2026-01-01T00:00:00.000Z' }],
      isTruncated: false,
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
    expect(mockOrchestratorDeleteBucket).not.toHaveBeenCalled();
  });

  it('returns 404 when tenant is not ready (no tenant means no bucket)', async () => {
    mockIsTenantReady.mockResolvedValue(null);

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(404);
    expect(mockGetPresignerContext).not.toHaveBeenCalled();
  });
});
