import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrgRole, SubscriptionStatus, ApiErrorCode } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BillingTable: { name: 'BillingTable' },
  },
}));

const s3ClientContext = {
  endpointUrl: 'https://s3.example.com',
  region: 'auto',
  credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
  forcePathStyle: true,
  orchestratorId: 'test',
  tenantId: 't-1',
};

const mockIsTenantReady = vi.fn();
const mockGetS3ClientContext = vi.fn();

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  isTenantReady: (...args: unknown[]) => mockIsTenantReady(...args),
  getS3ClientContext: (...args: unknown[]) => mockGetS3ClientContext(...args),
};

const mockGetOrchestratorForRegion = vi.fn();

vi.mock('../lib/service-orchestrator-registry.ts', () => ({
  getOrchestratorForRegion: (...args: unknown[]) => mockGetOrchestratorForRegion(...args),
}));

vi.mock('../lib/org-profile.ts', () => ({
  getOrgProfile: vi.fn(async (orgId: string) => ({ pk: { S: `ORG#${orgId}` } })),
}));

const mockGetPresignedListObjectsUrl = vi.fn();
const mockGetPresignedListObjectVersionsUrl = vi.fn();
const mockGetPresignedHeadObjectUrl = vi.fn();
const mockGetPresignedGetObjectRetentionUrl = vi.fn();
const mockGetPresignedGetObjectUrl = vi.fn();
const mockGetPresignedPutObjectUrl = vi.fn();
const mockGetPresignedDeleteObjectUrl = vi.fn();

vi.mock('../lib/s3-presigner.ts', () => ({
  getPresignedListObjectsUrl: (...args: unknown[]) => mockGetPresignedListObjectsUrl(...args),
  getPresignedListObjectVersionsUrl: (...args: unknown[]) =>
    mockGetPresignedListObjectVersionsUrl(...args),
  getPresignedHeadObjectUrl: (...args: unknown[]) => mockGetPresignedHeadObjectUrl(...args),
  getPresignedGetObjectRetentionUrl: (...args: unknown[]) =>
    mockGetPresignedGetObjectRetentionUrl(...args),
  getPresignedGetObjectUrl: (...args: unknown[]) => mockGetPresignedGetObjectUrl(...args),
  getPresignedPutObjectUrl: (...args: unknown[]) => mockGetPresignedPutObjectUrl(...args),
  getPresignedDeleteObjectUrl: (...args: unknown[]) => mockGetPresignedDeleteObjectUrl(...args),
}));

import { baseHandler } from './presign.ts';
import { buildEvent, membershipFor } from '../test/lambda-test-utilities.ts';
import { delegateIamMethods, FakeIamOrchestrator } from '../test/fake-iam-orchestrator.ts';

const USER_1 = '00000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: USER_1, orgId: 'org-1' };

function buildPresignEvent(
  ops: unknown[],
  overrides?: {
    subscriptionStatus?: string | null;
    region?: string | null;
    userInfo?: { email?: string; emailVerified?: boolean };
    role?: OrgRole;
  },
) {
  const region = overrides?.region === undefined ? 'eu-west-1' : overrides.region;
  const event = buildEvent({
    body: JSON.stringify(ops),
    userInfo: {
      ...USER_INFO,
      ...overrides?.userInfo,
      ...(overrides?.role
        ? { membership: membershipFor(USER_INFO.orgId, USER_INFO.userId, overrides.role) }
        : {}),
    },
    ...(region !== null && { queryStringParameters: { region } }),
  });
  // Default to Active so existing tests pass the trial gate.
  // Pass null explicitly to simulate a user with no billing record.
  const status =
    overrides?.subscriptionStatus === undefined
      ? SubscriptionStatus.Active
      : overrides.subscriptionStatus;
  if (status) {
    event.requestContext.subscriptionStatus = status;
  }
  return event;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('presign baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('FILONE_STAGE', 'staging');
    mockGetOrchestratorForRegion.mockReturnValue(mockOrchestrator);
    mockIsTenantReady.mockReturnValue('aurora-t-1');
    mockGetS3ClientContext.mockResolvedValue(s3ClientContext);
  });

  // ── Validation ──────────────────────────────────────────────────────

  it('returns 400 for invalid JSON body', async () => {
    const event = buildEvent({
      body: 'not json{',
      userInfo: USER_INFO,
      queryStringParameters: { region: 'eu-west-1' },
    });
    const result = await baseHandler(event);

    expect(result).toMatchObject({
      statusCode: 400,
      body: expect.stringContaining('Invalid JSON body'),
    });
  });

  it('returns 400 for empty array', async () => {
    const event = buildPresignEvent([]);
    const result = await baseHandler(event);

    expect(result).toMatchObject({
      statusCode: 400,
      body: expect.stringContaining('At least one operation is required'),
    });
  });

  it('returns 400 for invalid op schema', async () => {
    const event = buildPresignEvent([{ op: 'listObjects', bucket: '' }]);
    const result = await baseHandler(event);

    expect(result).toMatchObject({
      statusCode: 400,
      body: expect.stringContaining('Bucket name is required'),
    });
  });

  it('returns 400 for unknown op type', async () => {
    const event = buildPresignEvent([{ op: 'unknownOp', bucket: 'b' }]);
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
  });

  // ── Trial account shareable link blocking ───────────────────────────

  it('returns 402 for trial user generating shareable getObject URL', async () => {
    const event = buildPresignEvent(
      [{ op: 'getObject', bucket: 'b', key: 'k', expiresIn: 86400 }],
      { subscriptionStatus: SubscriptionStatus.Trialing },
    );
    const result = await baseHandler(event);

    expect(result).toMatchObject({
      statusCode: 402,
      body: expect.stringContaining(ApiErrorCode.TRIAL_PRESIGN_BLOCKED),
    });
  });

  it('returns 402 for new user (no billing record) generating shareable URL', async () => {
    const event = buildPresignEvent([{ op: 'getObject', bucket: 'b', key: 'k', expiresIn: 3600 }], {
      subscriptionStatus: null,
    });
    const result = await baseHandler(event);

    expect(result).toMatchObject({
      statusCode: 402,
      body: expect.stringContaining(ApiErrorCode.TRIAL_PRESIGN_BLOCKED),
    });
  });

  it('allows trial user to download (getObject without expiresIn)', async () => {
    mockGetPresignedGetObjectUrl.mockResolvedValue('https://s3.example.com/get?signed');

    const event = buildPresignEvent([{ op: 'getObject', bucket: 'b', key: 'k' }], {
      subscriptionStatus: SubscriptionStatus.Trialing,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
  });

  it('allows trial user to list objects', async () => {
    mockGetPresignedListObjectsUrl.mockResolvedValue('https://s3.example.com/list?signed');

    const event = buildPresignEvent([{ op: 'listObjects', bucket: 'b' }], {
      subscriptionStatus: SubscriptionStatus.Trialing,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
  });

  it('blocks trial user when batch contains a shareable URL among other ops', async () => {
    const event = buildPresignEvent(
      [
        { op: 'listObjects', bucket: 'b' },
        { op: 'getObject', bucket: 'b', key: 'k', expiresIn: 604800 },
      ],
      { subscriptionStatus: SubscriptionStatus.Trialing },
    );
    const result = await baseHandler(event);

    expect(result).toMatchObject({
      statusCode: 402,
      body: expect.stringContaining(ApiErrorCode.TRIAL_PRESIGN_BLOCKED),
    });
  });

  // ── Grace period / past due write blocking ──────────────────────────

  it('returns 403 for putObject during grace period', async () => {
    const event = buildPresignEvent(
      [{ op: 'putObject', bucket: 'b', key: 'k', contentType: 'text/plain', fileName: 'f.txt' }],
      { subscriptionStatus: SubscriptionStatus.GracePeriod },
    );
    const result = await baseHandler(event);

    expect(result).toMatchObject({
      statusCode: 403,
      body: expect.stringContaining(ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED),
    });
  });

  it('returns 403 for deleteObject during past due', async () => {
    const event = buildPresignEvent([{ op: 'deleteObject', bucket: 'b', key: 'k' }], {
      subscriptionStatus: SubscriptionStatus.PastDue,
    });
    const result = await baseHandler(event);

    expect(result).toMatchObject({
      statusCode: 403,
      body: expect.stringContaining(ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED),
    });
  });

  it('returns 403 for mixed read+write batch during grace period', async () => {
    const event = buildPresignEvent(
      [
        { op: 'listObjects', bucket: 'b' },
        { op: 'deleteObject', bucket: 'b', key: 'k' },
      ],
      { subscriptionStatus: SubscriptionStatus.GracePeriod },
    );
    const result = await baseHandler(event);

    expect(result).toMatchObject({
      statusCode: 403,
      body: expect.stringContaining(ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED),
    });
  });

  it('allows read-only batch during grace period', async () => {
    mockGetPresignedListObjectsUrl.mockResolvedValue('https://s3.example.com/list?signed');

    const event = buildPresignEvent([{ op: 'listObjects', bucket: 'b' }], {
      subscriptionStatus: SubscriptionStatus.GracePeriod,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
  });

  // ── Tenant readiness ────────────────────────────────────────────────

  it('returns 503 when the orchestrator tenant is not ready', async () => {
    mockIsTenantReady.mockReturnValue(null);

    const event = buildPresignEvent([{ op: 'listObjects', bucket: 'b' }]);
    const result = await baseHandler(event);

    expect(result).toMatchObject({
      statusCode: 503,
      body: expect.stringContaining('setting up the region for you'),
    });
  });

  // ── Successful presigning ───────────────────────────────────────────

  it('returns presigned URLs for a read-only batch', async () => {
    mockGetPresignedListObjectsUrl.mockResolvedValue('https://s3.example.com/list?signed');
    mockGetPresignedHeadObjectUrl.mockResolvedValue('https://s3.example.com/head?signed');

    const event = buildPresignEvent([
      { op: 'listObjects', bucket: 'b' },
      { op: 'headObject', bucket: 'b', key: 'k' },
    ]);
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toEqual({
      items: [
        {
          url: 'https://s3.example.com/list?signed',
          method: 'GET',
          expiresAt: expect.any(String),
        },
        {
          url: 'https://s3.example.com/head?signed',
          method: 'HEAD',
          expiresAt: expect.any(String),
        },
      ],
      endpoint: s3ClientContext.endpointUrl,
    });
  });

  it('presigns against presignEndpointUrl when the context carries one', async () => {
    mockGetS3ClientContext.mockResolvedValue({
      ...s3ClientContext,
      presignEndpointUrl: 'http://localhost:15130',
    });
    mockGetPresignedListObjectsUrl.mockResolvedValue('http://localhost:15130/b?signed');

    const result = await baseHandler(buildPresignEvent([{ op: 'listObjects', bucket: 'b' }]));

    expect(mockGetPresignedListObjectsUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ endpointUrl: 'http://localhost:15130' }),
      }),
    );
    expect(JSON.parse(result.body as string).endpoint).toBe('http://localhost:15130');
  });

  it('preserves item order matching request order', async () => {
    mockGetPresignedGetObjectUrl.mockResolvedValue('https://s3.example.com/get?signed');
    mockGetPresignedDeleteObjectUrl.mockResolvedValue('https://s3.example.com/delete?signed');
    mockGetPresignedListObjectsUrl.mockResolvedValue('https://s3.example.com/list?signed');

    const event = buildPresignEvent([
      { op: 'getObject', bucket: 'b', key: 'a' },
      { op: 'deleteObject', bucket: 'b', key: 'b' },
      { op: 'listObjects', bucket: 'b' },
    ]);
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toEqual({
      items: [
        {
          url: 'https://s3.example.com/get?signed',
          method: 'GET',
          expiresAt: expect.any(String),
        },
        {
          url: 'https://s3.example.com/delete?signed',
          method: 'DELETE',
          expiresAt: expect.any(String),
        },
        {
          url: 'https://s3.example.com/list?signed',
          method: 'GET',
          expiresAt: expect.any(String),
        },
      ],
      endpoint: s3ClientContext.endpointUrl,
    });
  });

  it('returns presigned URL for putObject with metadata', async () => {
    mockGetPresignedPutObjectUrl.mockResolvedValue('https://s3.example.com/put?signed');

    const event = buildPresignEvent([
      {
        op: 'putObject',
        bucket: 'b',
        key: 'doc.pdf',
        contentType: 'application/pdf',
        fileName: 'doc.pdf',
        description: 'A document',
        tags: ['important', 'report'],
      },
    ]);
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toEqual({
      items: [
        {
          url: 'https://s3.example.com/put?signed',
          method: 'PUT',
          expiresAt: expect.any(String),
        },
      ],
      endpoint: s3ClientContext.endpointUrl,
    });
    expect(mockGetPresignedPutObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'b',
        key: 'doc.pdf',
        contentType: 'application/pdf',
        metadata: {
          filename: 'doc.pdf',
          description: 'A document',
          tags: JSON.stringify(['important', 'report']),
        },
      }),
    );
  });

  it('returns presigned URL for getObjectRetention', async () => {
    mockGetPresignedGetObjectRetentionUrl.mockResolvedValue(
      'https://s3.example.com/retention?signed',
    );

    const event = buildPresignEvent([{ op: 'getObjectRetention', bucket: 'b', key: 'k' }]);
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toEqual({
      items: [
        {
          url: 'https://s3.example.com/retention?signed',
          method: 'GET',
          expiresAt: expect.any(String),
        },
      ],
      endpoint: s3ClientContext.endpointUrl,
    });
  });

  it('includes expiresAt on each item', async () => {
    mockGetPresignedListObjectsUrl.mockResolvedValue('https://s3.example.com/list?signed');

    const before = Date.now();
    const event = buildPresignEvent([{ op: 'listObjects', bucket: 'b' }]);
    const result = await baseHandler(event);

    const body = JSON.parse(result.body as string);
    const expiresAt = new Date(body.items[0].expiresAt).getTime();
    // Should be ~300s in the future (with some tolerance)
    expect(expiresAt).toBeGreaterThan(before + 290_000);
    expect(expiresAt).toBeLessThan(before + 310_000);
  });

  // ── listObjectVersions ────────────────────────────────────────────

  it('returns presigned URL for listObjectVersions', async () => {
    mockGetPresignedListObjectVersionsUrl.mockResolvedValue(
      'https://s3.example.com/versions?signed',
    );

    const event = buildPresignEvent([{ op: 'listObjectVersions', bucket: 'b', prefix: 'docs/' }]);
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.items[0]).toMatchObject({
      url: 'https://s3.example.com/versions?signed',
      method: 'GET',
    });
    expect(mockGetPresignedListObjectVersionsUrl).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'b', prefix: 'docs/' }),
    );
  });

  it('allows listObjectVersions during grace period (read-only)', async () => {
    mockGetPresignedListObjectVersionsUrl.mockResolvedValue(
      'https://s3.example.com/versions?signed',
    );

    const event = buildPresignEvent([{ op: 'listObjectVersions', bucket: 'b' }], {
      subscriptionStatus: SubscriptionStatus.GracePeriod,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
  });

  // ── versionId forwarding ──────────────────────────────────────────

  it('forwards versionId for headObject', async () => {
    mockGetPresignedHeadObjectUrl.mockResolvedValue('https://s3.example.com/head?signed');

    const event = buildPresignEvent([
      { op: 'headObject', bucket: 'b', key: 'k', versionId: 'v-123' },
    ]);
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    expect(mockGetPresignedHeadObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'k', versionId: 'v-123' }),
    );
  });

  it('forwards versionId for getObject', async () => {
    mockGetPresignedGetObjectUrl.mockResolvedValue('https://s3.example.com/get?signed');

    const event = buildPresignEvent([
      { op: 'getObject', bucket: 'b', key: 'k', versionId: 'v-456' },
    ]);
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    expect(mockGetPresignedGetObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'k', versionId: 'v-456' }),
    );
  });

  it('forwards versionId for deleteObject', async () => {
    mockGetPresignedDeleteObjectUrl.mockResolvedValue('https://s3.example.com/delete?signed');

    const event = buildPresignEvent([
      { op: 'deleteObject', bucket: 'b', key: 'k', versionId: 'v-789' },
    ]);
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    expect(mockGetPresignedDeleteObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'k', versionId: 'v-789' }),
    );
  });

  it('forwards versionId for getObjectRetention', async () => {
    mockGetPresignedGetObjectRetentionUrl.mockResolvedValue(
      'https://s3.example.com/retention?signed',
    );

    const event = buildPresignEvent([
      { op: 'getObjectRetention', bucket: 'b', key: 'k', versionId: 'v-abc' },
    ]);
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    expect(mockGetPresignedGetObjectRetentionUrl).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'k', versionId: 'v-abc' }),
    );
  });

  // ── Region routing ────────────────────────────────────────────────

  describe('member scope on an iam region', () => {
    const mockResolveMemberAccess = vi.fn();
    const iamOrchestrator = {
      ...mockOrchestrator,
      // The region table says us-east-9 serves the `iam` access model.
      region: 'us-east-9',
      ...delegateIamMethods(new FakeIamOrchestrator()),
      resolveMemberAccess: (...args: unknown[]) => mockResolveMemberAccess(...args),
    };
    const grantActionsOnBucket = (bucketName: string, actions: string[]) => [
      { bucketName, actions },
    ];
    const buildGetObjectOps = (bucket: string) => [{ op: 'getObject', bucket, key: 'k' }];

    beforeEach(() => {
      mockGetOrchestratorForRegion.mockReturnValue(iamOrchestrator);
    });

    it('presigns getObject for a Member whose policy grants s3:GetObject', async () => {
      mockResolveMemberAccess.mockResolvedValue(grantActionsOnBucket('b', ['s3:GetObject']));

      const result = await baseHandler(
        buildPresignEvent(buildGetObjectOps('b'), { role: OrgRole.Member }),
      );

      expect(result.statusCode).toBe(200);
      expect(mockGetPresignedGetObjectUrl).toHaveBeenCalledTimes(1);
    });

    it("looks up the Member's access by tenant and user id", async () => {
      mockResolveMemberAccess.mockResolvedValue(grantActionsOnBucket('b', ['s3:GetObject']));

      await baseHandler(buildPresignEvent(buildGetObjectOps('b'), { role: OrgRole.Member }));

      expect(mockResolveMemberAccess).toHaveBeenCalledWith('aurora-t-1', USER_1);
    });

    it("signs with the tenant's S3 context", async () => {
      mockResolveMemberAccess.mockResolvedValue(grantActionsOnBucket('b', ['s3:GetObject']));

      await baseHandler(buildPresignEvent(buildGetObjectOps('b'), { role: OrgRole.Member }));

      expect(mockGetS3ClientContext).toHaveBeenCalledWith('aurora-t-1');
    });

    it('returns the same 404 as a missing bucket when no policy grants the Member the bucket', async () => {
      mockResolveMemberAccess.mockResolvedValue(grantActionsOnBucket('other', ['s3:GetObject']));

      const result = await baseHandler(
        buildPresignEvent(buildGetObjectOps('b'), { role: OrgRole.Member }),
      );

      // A distinct status or body would confirm that the bucket exists.
      expect({ statusCode: result.statusCode, body: JSON.parse(result.body!) }).toStrictEqual({
        statusCode: 404,
        body: { message: 'Bucket not found' },
      });
      expect(mockGetPresignedGetObjectUrl).not.toHaveBeenCalled();
    });

    it("refuses an operation the bucket's policy does not grant", async () => {
      mockResolveMemberAccess.mockResolvedValue(grantActionsOnBucket('b', ['s3:GetObject']));

      const result = await baseHandler(
        buildPresignEvent(
          [{ op: 'putObject', bucket: 'b', key: 'k', contentType: 'text/plain', fileName: 'k' }],
          { role: OrgRole.Member },
        ),
      );

      expect({ statusCode: result.statusCode, body: JSON.parse(result.body!) }).toStrictEqual({
        statusCode: 403,
        body: { message: 'Your access to b does not permit putObject.' },
      });
      expect(mockGetPresignedPutObjectUrl).not.toHaveBeenCalled();
    });

    it('refuses deleteObject with the missing-bucket 404 when no policy grants the Member the bucket', async () => {
      mockResolveMemberAccess.mockResolvedValue(grantActionsOnBucket('other', ['s3:DeleteObject']));

      const result = await baseHandler(
        buildPresignEvent([{ op: 'deleteObject', bucket: 'b', key: 'k' }], {
          role: OrgRole.Member,
        }),
      );

      expect({ statusCode: result.statusCode, body: JSON.parse(result.body!) }).toStrictEqual({
        statusCode: 404,
        body: { message: 'Bucket not found' },
      });
      expect(mockGetPresignedDeleteObjectUrl).not.toHaveBeenCalled();
    });

    it('refuses deleteObject when the bucket policy grants the Member no s3:DeleteObject', async () => {
      mockResolveMemberAccess.mockResolvedValue(
        grantActionsOnBucket('b', ['s3:GetObject', 's3:ListBucket']),
      );

      const result = await baseHandler(
        buildPresignEvent([{ op: 'deleteObject', bucket: 'b', key: 'k' }], {
          role: OrgRole.Member,
        }),
      );

      expect({ statusCode: result.statusCode, body: JSON.parse(result.body!) }).toStrictEqual({
        statusCode: 403,
        body: { message: 'Your access to b does not permit deleteObject.' },
      });
      expect(mockGetPresignedDeleteObjectUrl).not.toHaveBeenCalled();
    });

    // The gateway classifies a versioned read or delete as s3:GetObjectVersion
    // or s3:DeleteObjectVersion; the tenant-signed URL skips that evaluation.
    it.each([
      ['getObject', 's3:GetObject'],
      ['headObject', 's3:GetObject'],
      ['deleteObject', 's3:DeleteObject'],
    ])('returns 403 for a versioned %s when the policy grants only %s', async (op, action) => {
      mockResolveMemberAccess.mockResolvedValue(grantActionsOnBucket('b', [action]));

      const result = await baseHandler(
        buildPresignEvent([{ op, bucket: 'b', key: 'k', versionId: 'v1' }], {
          role: OrgRole.Member,
        }),
      );

      expect(result.statusCode).toBe(403);
    });

    it.each([
      ['getObject', 's3:GetObjectVersion'],
      ['headObject', 's3:GetObjectVersion'],
      ['deleteObject', 's3:DeleteObjectVersion'],
    ])('presigns a versioned %s the policy grants', async (op, action) => {
      mockResolveMemberAccess.mockResolvedValue(grantActionsOnBucket('b', [action]));

      const result = await baseHandler(
        buildPresignEvent([{ op, bucket: 'b', key: 'k', versionId: 'v1' }], {
          role: OrgRole.Member,
        }),
      );

      expect(result.statusCode).toBe(200);
    });

    // An Owner or Admin must open a bucket whose policy leaves them out, or has
    // none, to repair it, so the console never looks up their access.
    it.each([OrgRole.Owner, OrgRole.Admin])('skips the access lookup for an %s', async (role) => {
      await baseHandler(buildPresignEvent([{ op: 'listObjects', bucket: 'b' }], { role }));

      expect(mockResolveMemberAccess).not.toHaveBeenCalled();
    });

    it.each([OrgRole.Member, OrgRole.ReadOnly])('looks up access for a %s', async (role) => {
      mockResolveMemberAccess.mockResolvedValue(grantActionsOnBucket('b', ['s3:ListBucket']));

      await baseHandler(buildPresignEvent([{ op: 'listObjects', bucket: 'b' }], { role }));

      expect(mockResolveMemberAccess).toHaveBeenCalledTimes(1);
    });

    it('skips the access lookup on a service-keys region', async () => {
      mockGetOrchestratorForRegion.mockReturnValue(mockOrchestrator);

      const result = await baseHandler(
        buildPresignEvent([{ op: 'listObjects', bucket: 'b' }], { role: OrgRole.Member }),
      );

      expect(result.statusCode).toBe(200);
      expect(mockResolveMemberAccess).not.toHaveBeenCalled();
    });
  });

  describe('region routing', () => {
    it('returns 400 when region query parameter is missing', async () => {
      const event = buildPresignEvent([{ op: 'listObjects', bucket: 'b' }], { region: null });
      const result = await baseHandler(event);

      expect(result).toMatchObject({
        statusCode: 400,
        body: expect.stringContaining('region query parameter is required'),
      });
      expect(mockGetOrchestratorForRegion).not.toHaveBeenCalled();
    });

    it('returns an unsupported-region response when region is not allowed in this stage', async () => {
      const event = buildPresignEvent([{ op: 'listObjects', bucket: 'b' }], {
        region: 'ap-south-1',
      });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(400);
      expect(result.body).toEqual(expect.stringContaining('ap-south-1'));
      expect(mockGetOrchestratorForRegion).not.toHaveBeenCalled();
    });

    it('accepts us-east-1 in production for any user (soft-launched region)', async () => {
      vi.stubEnv('FILONE_STAGE', 'production');
      mockGetPresignedListObjectsUrl.mockResolvedValue('https://s3.example.com/list?signed');
      const event = buildPresignEvent([{ op: 'listObjects', bucket: 'b' }], {
        region: 'us-east-1',
      });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(200);
      expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith('us-east-1');
    });

    it('routes the request to the orchestrator for the supplied region', async () => {
      mockGetPresignedListObjectsUrl.mockResolvedValue('https://s3.example.com/list?signed');

      const event = buildPresignEvent([{ op: 'listObjects', bucket: 'b' }], {
        region: 'us-east-1',
      });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(200);
      expect(mockGetOrchestratorForRegion).toHaveBeenCalledWith('us-east-1');
    });
  });

  // ── Role enforcement ────────────────────────────────────────────────

  describe('per-operation permissions', () => {
    // One route serves seven operations, so the requirement is the operation's,
    // not the route's — the manifest marks it in-handler and lists this mapping.
    beforeEach(() => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mockGetPresignedListObjectsUrl.mockResolvedValue('https://s3.example.com/list?signed');
      mockGetPresignedGetObjectUrl.mockResolvedValue('https://s3.example.com/get?signed');
      mockGetPresignedHeadObjectUrl.mockResolvedValue('https://s3.example.com/head?signed');
      mockGetPresignedGetObjectRetentionUrl.mockResolvedValue(
        'https://s3.example.com/retention?signed',
      );
      mockGetPresignedListObjectVersionsUrl.mockResolvedValue(
        'https://s3.example.com/versions?signed',
      );
      mockGetPresignedPutObjectUrl.mockResolvedValue('https://s3.example.com/put?signed');
      mockGetPresignedDeleteObjectUrl.mockResolvedValue('https://s3.example.com/delete?signed');
    });

    const READ_OPS = [
      { op: 'getObject', bucket: 'b', key: 'k' },
      { op: 'headObject', bucket: 'b', key: 'k' },
      { op: 'listObjects', bucket: 'b' },
      { op: 'listObjectVersions', bucket: 'b' },
      { op: 'getObjectRetention', bucket: 'b', key: 'k' },
    ];

    it.each(READ_OPS)('lets ReadOnly presign $op', async (op) => {
      const result = await baseHandler(buildPresignEvent([op], { role: OrgRole.ReadOnly }));

      expect(result.statusCode).toBe(200);
    });

    it.each([
      ['putObject', { op: 'putObject', bucket: 'b', key: 'k', fileName: 'f', contentType: 't' }],
      ['deleteObject', { op: 'deleteObject', bucket: 'b', key: 'k' }],
    ])('refuses ReadOnly on %s, naming it', async (name, op) => {
      const result = await baseHandler(buildPresignEvent([op], { role: OrgRole.ReadOnly }));

      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body!)).toStrictEqual({
        message: `Your role in this organization does not permit ${name}.`,
        code: ApiErrorCode.FORBIDDEN_ROLE,
      });
    });

    it('lets a Member write and delete objects', async () => {
      const result = await baseHandler(
        buildPresignEvent(
          [
            { op: 'putObject', bucket: 'b', key: 'k', fileName: 'f', contentType: 't' },
            { op: 'deleteObject', bucket: 'b', key: 'k' },
          ],
          { role: OrgRole.Member },
        ),
      );

      expect(result.statusCode).toBe(200);
    });

    it('refuses the whole batch when one operation is denied', async () => {
      const result = await baseHandler(
        buildPresignEvent(
          [
            { op: 'listObjects', bucket: 'b' },
            { op: 'deleteObject', bucket: 'b', key: 'k' },
          ],
          { role: OrgRole.ReadOnly },
        ),
      );

      expect(result.statusCode).toBe(403);
      // Not one URL of the batch: a partial response is indistinguishable from
      // the set the caller was entitled to.
      expect(mockGetPresignedListObjectsUrl).not.toHaveBeenCalled();
    });

    it('refuses a caller with no membership row', async () => {
      const event = buildPresignEvent([{ op: 'listObjects', bucket: 'b' }]);
      event.requestContext.userInfo.membership = undefined;

      const result = await baseHandler(event);

      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body!).code).toBe(ApiErrorCode.NOT_A_MEMBER);
    });

    it('denies on role before it denies on billing', async () => {
      // A shareable link on a trial is a 402 and a ReadOnly delete is a 403.
      // Asking for both gets the 403: what a role permits does not depend on
      // the plan, and a member refused an operation should hear that rather
      // than be told to upgrade.
      const result = await baseHandler(
        buildPresignEvent(
          [
            { op: 'getObject', bucket: 'b', key: 'k', expiresIn: 3600 },
            { op: 'deleteObject', bucket: 'b', key: 'k' },
          ],
          { role: OrgRole.ReadOnly, subscriptionStatus: SubscriptionStatus.Trialing },
        ),
      );

      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body!).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    });
  });
});
