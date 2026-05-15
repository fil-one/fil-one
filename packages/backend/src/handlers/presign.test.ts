import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { FINAL_SETUP_STATUS } from '../lib/org-setup-status.js';
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

const mockGetAuroraS3Credentials = vi.fn();
const mockGetPresignedListObjectsUrl = vi.fn();
const mockGetPresignedListObjectVersionsUrl = vi.fn();
const mockGetPresignedHeadObjectUrl = vi.fn();
const mockGetPresignedGetObjectRetentionUrl = vi.fn();
const mockGetPresignedGetObjectUrl = vi.fn();
const mockGetPresignedPutObjectUrl = vi.fn();
const mockGetPresignedDeleteObjectUrl = vi.fn();

vi.mock('../lib/aurora-s3-client.js', () => ({
  getAuroraS3Credentials: (...args: unknown[]) => mockGetAuroraS3Credentials(...args),
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

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './presign.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function orgProfileWithTenant(tenantId: string) {
  return {
    Item: {
      pk: { S: `ORG#${USER_INFO.orgId}` },
      sk: { S: 'PROFILE' },
      auroraTenantId: { S: tenantId },
      setupStatus: { S: FINAL_SETUP_STATUS },
    },
  };
}

function buildPresignEvent(ops: unknown[], overrides?: { subscriptionStatus?: string }) {
  const event = buildEvent({
    body: JSON.stringify(ops),
    userInfo: USER_INFO,
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
    ddbMock.reset();
    vi.stubEnv('FILONE_STAGE', 'test');
    mockGetAuroraS3Credentials.mockResolvedValue({
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
    });
  });

  // ── Validation ──────────────────────────────────────────────────────

  it('returns 400 for invalid JSON body', async () => {
    const event = buildEvent({ body: 'not json{', userInfo: USER_INFO });
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
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetPresignedListObjectsUrl.mockResolvedValue('https://s3.example.com/list?signed');

    const event = buildPresignEvent([{ op: 'listObjects', bucket: 'b' }], {
      subscriptionStatus: SubscriptionStatus.GracePeriod,
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
  });

  // ── Org setup ───────────────────────────────────────────────────────

  it('returns 503 when aurora tenant setup is incomplete', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: `ORG#${USER_INFO.orgId}` },
        sk: { S: 'PROFILE' },
        auroraTenantId: { S: 'aurora-t-1' },
        setupStatus: { S: 'AURORA_TENANT_CREATED' },
      },
    });

    const event = buildPresignEvent([{ op: 'listObjects', bucket: 'b' }]);
    const result = await baseHandler(event);

    expect(result).toMatchObject({
      statusCode: 503,
      body: expect.stringContaining('Aurora tenant setup is not complete'),
    });
  });

  it('returns 503 when auroraTenantId is missing', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: `ORG#${USER_INFO.orgId}` },
        sk: { S: 'PROFILE' },
      },
    });

    const event = buildPresignEvent([{ op: 'listObjects', bucket: 'b' }]);
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
  });

  // ── Successful presigning ───────────────────────────────────────────

  it('returns presigned URLs for a read-only batch', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
      endpoint: expect.any(String),
    });
  });

  it('preserves item order matching request order', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
      endpoint: expect.any(String),
    });
  });

  it('returns presigned URL for putObject with metadata', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
      endpoint: expect.any(String),
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
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
      endpoint: expect.any(String),
    });
  });

  it('includes expiresAt on each item', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
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
});
