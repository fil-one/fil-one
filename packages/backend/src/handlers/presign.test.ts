import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubscriptionStatus, ApiErrorCode } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    BillingTable: { name: 'BillingTable' },
  },
}));

const presignerContext = {
  endpointUrl: 'https://s3.example.com',
  region: 'auto',
  credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
  forcePathStyle: true,
};

const mockIsTenantReady = vi.fn();
const mockGetPresignerContext = vi.fn();

const mockOrchestrator = {
  id: 'aurora',
  region: 'eu-west-1',
  isTenantReady: (...args: unknown[]) => mockIsTenantReady(...args),
  getPresignerContext: (...args: unknown[]) => mockGetPresignerContext(...args),
};

const mockGetOrchestratorForRegion = vi.fn();

vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getOrchestratorForRegion: (...args: unknown[]) => mockGetOrchestratorForRegion(...args),
}));

const mockGetPresignedListObjectsUrl = vi.fn();
const mockGetPresignedListObjectVersionsUrl = vi.fn();
const mockGetPresignedHeadObjectUrl = vi.fn();
const mockGetPresignedGetObjectRetentionUrl = vi.fn();
const mockGetPresignedGetObjectUrl = vi.fn();
const mockGetPresignedPutObjectUrl = vi.fn();
const mockGetPresignedDeleteObjectUrl = vi.fn();

vi.mock('../lib/s3-presigner.js', () => ({
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

import { baseHandler } from './presign.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function buildPresignEvent(
  ops: unknown[],
  overrides?: { subscriptionStatus?: string; region?: string | null },
) {
  const region = overrides?.region === undefined ? 'eu-west-1' : overrides.region;
  const event = buildEvent({
    body: JSON.stringify(ops),
    userInfo: USER_INFO,
    ...(region !== null && { queryStringParameters: { region } }),
  });
  if (overrides?.subscriptionStatus) {
    event.requestContext.subscriptionStatus = overrides.subscriptionStatus;
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
    mockIsTenantReady.mockResolvedValue('aurora-t-1');
    mockGetPresignerContext.mockResolvedValue(presignerContext);
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
    mockIsTenantReady.mockResolvedValue(null);

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
      endpoint: presignerContext.endpointUrl,
    });
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
      endpoint: presignerContext.endpointUrl,
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
      endpoint: presignerContext.endpointUrl,
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
      endpoint: presignerContext.endpointUrl,
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

    it('rejects us-east-1 when stage is production', async () => {
      vi.stubEnv('FILONE_STAGE', 'production');
      const event = buildPresignEvent([{ op: 'listObjects', bucket: 'b' }], {
        region: 'us-east-1',
      });
      const result = await baseHandler(event);

      expect(result.statusCode).toBe(400);
      expect(result.body).toEqual(expect.stringContaining('us-east-1'));
      expect(mockGetOrchestratorForRegion).not.toHaveBeenCalled();
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
});
