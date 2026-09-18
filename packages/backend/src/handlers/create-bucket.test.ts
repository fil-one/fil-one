import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => sstResourceMock());

const mockEnsureTenantReady = vi.fn();
const mockCreateBucket = vi.fn();
const mockGetOrchestratorForRegion = vi.fn();

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  accessModel: 'scoped-keys',
  ensureTenantReady: (...args: unknown[]) => mockEnsureTenantReady(...args),
  createBucket: (...args: unknown[]) => mockCreateBucket(...args),
};

// One region serves the `iam` model in these tests, so the roster policy the
// create carries can be asserted while every real region is still dark.
const IAM_REGION = 'us-east-9';
const iamOrchestrator = {
  ...mockOrchestrator,
  id: 'forgeDev',
  region: IAM_REGION,
  accessModel: 'iam',
};

vi.mock('../lib/service-orchestrator-registry.ts', () => ({
  getOrchestratorForRegion: (region: string) => {
    mockGetOrchestratorForRegion(region);
    return region === IAM_REGION ? iamOrchestrator : mockOrchestrator;
  },
}));

const ddbMock = mockClient(DynamoDBClient);

const mockIsOrgDeleting = vi.fn(
  async (_orgId: string, _options?: { consistent?: boolean }) => false,
);

vi.mock('../lib/org-profile.ts', async () => ({
  ...(await vi.importActual<typeof import('../lib/org-profile.ts')>('../lib/org-profile.ts')),
  isOrgDeleting: (...args: Parameters<typeof mockIsOrgDeleting>) => mockIsOrgDeleting(...args),
}));

const mockListMembers = vi.fn(async (_orgId: string) => [] as { userId: string; role: string }[]);
vi.mock('../lib/org-membership.ts', () => ({
  listMembers: (orgId: string) => mockListMembers(orgId),
}));

import { baseHandler } from './create-bucket.ts';
import {
  BucketAlreadyExistsError,
  BucketConfigurationError,
  PolicyValidationError,
} from '../lib/errors.ts';
import { buildEvent } from '../test/lambda-test-utilities.ts';
import {
  OrgRole,
  ROSTER_ADMIN_ACTIONS,
  ROSTER_ADMINS_SID,
  ROSTER_CREATOR_SID,
  ROSTER_OWNERS_SID,
  S3_REGION,
  S3Region,
} from '@filone/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function validBody() {
  return JSON.stringify({ bucketName: 'my-bucket', region: S3_REGION });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('create-bucket baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ddbMock.on(PutItemCommand).resolves({});
    mockEnsureTenantReady.mockResolvedValue('aurora-t-1');
    mockIsOrgDeleting.mockResolvedValue(false);
  });

  it('410s without creating a bucket when the org is being deleted', async () => {
    mockIsOrgDeleting.mockResolvedValue(true);

    const result = await baseHandler(buildEvent({ body: validBody(), userInfo: USER_INFO }));

    expect(result.statusCode).toBe(410);
    expect(mockEnsureTenantReady).not.toHaveBeenCalled();
    expect(mockCreateBucket).not.toHaveBeenCalled();
  });

  it('reads the fence consistently', async () => {
    await baseHandler(buildEvent({ body: validBody(), userInfo: USER_INFO }));

    expect(mockIsOrgDeleting).toHaveBeenCalledWith('org-1', { consistent: true });
  });

  it('returns 201 and calls orchestrator.createBucket on success', async () => {
    mockCreateBucket.mockResolvedValue(undefined);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateBucket).toHaveBeenCalledWith('aurora-t-1', {
      bucketName: 'my-bucket',
      versioning: false,
      lock: false,
      retention: undefined,
    });
  });

  it('drives tenant setup via ensureTenantReady before creating the bucket', async () => {
    mockCreateBucket.mockResolvedValue(undefined);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    await baseHandler(event);

    expect(mockEnsureTenantReady).toHaveBeenCalledWith('org-1');
  });

  it('returns 503 with a retry message when tenant setup fails', async () => {
    mockEnsureTenantReady.mockResolvedValue(null);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    const body = JSON.parse(result.body as string);
    expect(body.message).toMatch(/setting up the region for you/i);
    expect(mockCreateBucket).not.toHaveBeenCalled();
  });

  it('throws when the orchestrator fails', async () => {
    mockCreateBucket.mockRejectedValue(new Error('Aurora API error'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });

    await expect(baseHandler(event)).rejects.toThrow('Aurora API error');
  });

  it('returns 409 when the bucket already exists', async () => {
    mockCreateBucket.mockRejectedValue(new BucketAlreadyExistsError('my-bucket'));

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
  });

  it('surfaces the actionable message when configuration fails after create', async () => {
    const err = new BucketConfigurationError('my-bucket');
    mockCreateBucket.mockRejectedValue(err);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body as string);
    // Not the generic errorHandlerMiddleware message — the caller gets remediation guidance.
    expect(body.message).toBe(err.message);
    expect(body.message).toContain('apply the remaining settings manually with the S3 API');
  });

  it('passes versioning, lock, and retention to orchestrator.createBucket', async () => {
    mockCreateBucket.mockResolvedValue(undefined);

    const event = buildEvent({
      body: JSON.stringify({
        bucketName: 'my-bucket',
        region: S3_REGION,
        versioning: true,
        lock: true,
        retention: { enabled: true, mode: 'governance', duration: 30, durationType: 'd' },
      }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateBucket).toHaveBeenCalledWith('aurora-t-1', {
      bucketName: 'my-bucket',
      versioning: true,
      lock: true,
      retention: { enabled: true, mode: 'governance', duration: 30, durationType: 'd' },
    });
  });

  it('defaults versioning and lock to false when not provided', async () => {
    mockCreateBucket.mockResolvedValue(undefined);

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    expect(mockCreateBucket).toHaveBeenCalledWith('aurora-t-1', {
      bucketName: 'my-bucket',
      versioning: false,
      lock: false,
      retention: undefined,
    });
  });

  it('returns 400 when lock is true but versioning is false', async () => {
    const event = buildEvent({
      body: JSON.stringify({ bucketName: 'my-bucket', region: S3_REGION, lock: true }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('Versioning must be enabled');
    expect(mockCreateBucket).not.toHaveBeenCalled();
  });

  it('returns 400 when retention is provided without lock', async () => {
    const event = buildEvent({
      body: JSON.stringify({
        bucketName: 'my-bucket',
        region: S3_REGION,
        versioning: true,
        retention: { enabled: true, mode: 'governance', duration: 30, durationType: 'd' },
      }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('Object Lock must be enabled');
    expect(mockCreateBucket).not.toHaveBeenCalled();
  });

  it('selects the orchestrator using the region from the request body', async () => {
    mockCreateBucket.mockResolvedValue(undefined);

    const event = buildEvent({
      body: JSON.stringify({ bucketName: 'my-bucket', region: S3Region.UsEast1 }),
      userInfo: USER_INFO,
    });
    await baseHandler(event);

    expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith(S3Region.UsEast1);
  });

  it('returns 400 when region is unsupported', async () => {
    const event = buildEvent({
      body: JSON.stringify({ bucketName: 'my-bucket', region: 'us-west-2' }),
      userInfo: USER_INFO,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string);
    expect(body.message).toContain('Unsupported region');
    expect(mockCreateBucket).not.toHaveBeenCalled();
  });

  it('accepts us-east-1 in production for any user (soft-launched region)', async () => {
    const previous = process.env.FILONE_STAGE;
    process.env.FILONE_STAGE = 'production';
    mockCreateBucket.mockResolvedValue(undefined);
    try {
      const event = buildEvent({
        body: JSON.stringify({ bucketName: 'my-bucket', region: S3Region.UsEast1 }),
        userInfo: USER_INFO,
      });
      await baseHandler(event);

      expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith(S3Region.UsEast1);
    } finally {
      process.env.FILONE_STAGE = previous;
    }
  });

  describe('on a region serving the iam access model', () => {
    const iamBody = () => JSON.stringify({ bucketName: 'my-bucket', region: IAM_REGION });

    it('carries the roster policy on the create, with the creator in a statement of their own', async () => {
      mockCreateBucket.mockResolvedValue(undefined);
      mockListMembers.mockResolvedValue([
        { userId: 'owner-1', role: OrgRole.Owner },
        { userId: 'admin-1', role: OrgRole.Admin },
        { userId: 'user-1', role: OrgRole.Member },
        { userId: 'reader-1', role: OrgRole.ReadOnly },
      ]);

      const result = await baseHandler(buildEvent({ body: iamBody(), userInfo: USER_INFO }));

      expect(result.statusCode).toBe(201);
      expect(mockListMembers).toHaveBeenCalledWith('org-1');
      expect(mockCreateBucket).toHaveBeenCalledWith(
        'aurora-t-1',
        expect.objectContaining({
          policy: {
            statement: [
              { sid: ROSTER_OWNERS_SID, effect: 'allow', principal: ['owner-1'], action: ['s3:*'] },
              {
                sid: ROSTER_ADMINS_SID,
                effect: 'allow',
                principal: ['admin-1'],
                action: ROSTER_ADMIN_ACTIONS,
              },
              {
                sid: ROSTER_CREATOR_SID,
                effect: 'allow',
                principal: ['user-1'],
                action: ROSTER_ADMIN_ACTIONS,
              },
            ],
          },
        }),
      );
    });

    it('records the first policy as a bucket-created write, intent before completion', async () => {
      mockCreateBucket.mockResolvedValue(undefined);
      mockListMembers.mockResolvedValue([{ userId: 'user-1', role: OrgRole.Owner }]);

      await baseHandler(buildEvent({ body: iamBody(), userInfo: USER_INFO }));

      const events = ddbMock
        .commandCalls(PutItemCommand)
        .map((call) => unmarshall(call.args[0].input.Item ?? {}));
      expect(events.map((e) => [e.type, e.phase])).toStrictEqual([
        ['bucket_policy.created', 'intent'],
        ['bucket_policy.created', 'completion'],
      ]);
      expect(events[0]!.details).toMatchObject({ region: IAM_REGION, trigger: 'bucket_created' });
      expect(events[1]).toMatchObject({ outcome: 'succeeded', details: { statements: 1 } });
    });

    it('answers 400 when the storage system refuses the policy, since no bucket was created', async () => {
      mockListMembers.mockResolvedValue([{ userId: 'user-1', role: OrgRole.Owner }]);
      mockCreateBucket.mockRejectedValue(new PolicyValidationError('unknown principal'));

      const result = await baseHandler(buildEvent({ body: iamBody(), userInfo: USER_INFO }));

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).message).toBe('unknown principal');
    });
  });

  it('carries no policy, reads no roster and writes no event on a scoped-keys region', async () => {
    mockCreateBucket.mockResolvedValue(undefined);

    await baseHandler(buildEvent({ body: validBody(), userInfo: USER_INFO }));

    expect(mockListMembers).not.toHaveBeenCalled();
    expect(mockCreateBucket.mock.calls[0]![1]).not.toHaveProperty('policy');
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });
});
