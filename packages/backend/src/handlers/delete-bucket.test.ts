import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotImplementedError } from '../lib/errors.js';

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

  it('returns 501 when the orchestrator throws NotImplementedError', async () => {
    mockOrchestratorDeleteBucket.mockRejectedValue(
      new NotImplementedError('Aurora bucket deletion is not yet supported. See FIL-204.'),
    );

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(501);
    expect(mockOrchestratorDeleteBucket).toHaveBeenCalledWith('aurora-t-1', 'my-bucket');
  });
});
