import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockIsTenantReady = vi.fn();
const mockOrchestratorDeleteBucket = vi.fn();

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  isTenantReady: (...args: unknown[]) => mockIsTenantReady(...args),
  deleteBucket: (...args: unknown[]) => mockOrchestratorDeleteBucket(...args),
};

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: () => mockOrchestrator,
}));

vi.mock('../lib/org-profile.js', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
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
    mockIsTenantReady.mockReturnValue('aurora-t-1');
  });

  it('returns 400 when bucket name is missing from path', async () => {
    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 503 when tenant is not ready', async () => {
    mockIsTenantReady.mockReturnValue(null);

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockOrchestratorDeleteBucket).not.toHaveBeenCalled();
  });

  it('returns 204 with an empty body and calls orchestrator.deleteBucket on success', async () => {
    mockOrchestratorDeleteBucket.mockResolvedValue(undefined);

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(204);
    expect(result.body).toBe('');
    expect(mockOrchestratorDeleteBucket).toHaveBeenCalledWith('aurora-t-1', 'my-bucket');
  });

  it('passes the tenantId from isTenantReady through to deleteBucket', async () => {
    mockIsTenantReady.mockReturnValue('tenant-xyz');
    mockOrchestratorDeleteBucket.mockResolvedValue(undefined);

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'some-bucket' };
    await baseHandler(event);

    expect(mockOrchestratorDeleteBucket).toHaveBeenCalledWith('tenant-xyz', 'some-bucket');
  });

  // Only NotImplementedError is translated to a response here; every other
  // failure propagates to errorHandlerMiddleware (which renders the 5xx).
  it('rethrows non-NotImplementedError failures from the orchestrator', async () => {
    mockOrchestratorDeleteBucket.mockRejectedValue(new Error('S3 gateway unavailable'));

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };

    await expect(baseHandler(event)).rejects.toThrow('S3 gateway unavailable');
  });
});
