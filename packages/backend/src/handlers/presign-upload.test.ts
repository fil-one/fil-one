import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Region } from '@filone/shared';
import { FINAL_SETUP_STATUS } from '../lib/org-setup-status.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const s3ClientSentinel = Symbol('s3-client');
const mockGetAuroraS3Client = vi.fn((..._args: unknown[]) => s3ClientSentinel);
const mockGetPresignedPutObjectUrl = vi.fn();

vi.mock('../lib/aurora-s3-client.js', () => ({
  getAuroraS3Client: (...args: unknown[]) => mockGetAuroraS3Client(...args),
  getPresignedPutObjectUrl: (...args: unknown[]) => mockGetPresignedPutObjectUrl(...args),
}));

process.env.FILONE_STAGE = 'test';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './presign-upload.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function validBody() {
  return JSON.stringify({ key: 'photos/cat.jpg', contentType: 'image/jpeg', fileName: 'cat.jpg' });
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('presign-upload baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 200 with presigned URL on success', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    const presignedUrl = 'https://s3.example/my-bucket/photos/cat.jpg?sig=abc';
    mockGetPresignedPutObjectUrl.mockResolvedValue(presignedUrl);

    const event = buildEvent({
      body: validBody(),
      userInfo: USER_INFO,
      rawPath: '/api/buckets/my-bucket/objects/presign',
    });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({ url: presignedUrl, key: 'photos/cat.jpg' });

    expect(mockGetAuroraS3Client).toHaveBeenCalledWith('test', S3Region.EuWest1, 'aurora-t-1');
    expect(mockGetPresignedPutObjectUrl).toHaveBeenCalledWith(s3ClientSentinel, {
      bucket: 'my-bucket',
      key: 'photos/cat.jpg',
      expiresIn: 300,
      contentType: 'image/jpeg',
      metadata: { filename: 'cat.jpg' },
    });
  });

  it('returns 400 when bucket name is missing from path', async () => {
    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when key is missing from body', async () => {
    const event = buildEvent({
      body: JSON.stringify({ contentType: 'image/jpeg', fileName: 'cat.jpg' }),
      userInfo: USER_INFO,
    });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when contentType is missing from body', async () => {
    const event = buildEvent({
      body: JSON.stringify({ key: 'test.txt', fileName: 'test.txt' }),
      userInfo: USER_INFO,
    });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when fileName is missing from body', async () => {
    const event = buildEvent({
      body: JSON.stringify({ key: 'test.txt', contentType: 'text/plain' }),
      userInfo: USER_INFO,
    });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
  });

  it('includes tags in metadata when provided', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetPresignedPutObjectUrl.mockResolvedValue(
      'https://s3.dev.aur.lu/my-bucket/photos/cat.jpg?sig=abc',
    );

    const event = buildEvent({
      body: JSON.stringify({
        key: 'photos/cat.jpg',
        contentType: 'image/jpeg',
        fileName: 'cat.jpg',
        tags: ['vacation', 'pets'],
      }),
      userInfo: USER_INFO,
      rawPath: '/api/buckets/my-bucket/objects/presign',
    });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({
      url: 'https://s3.dev.aur.lu/my-bucket/photos/cat.jpg?sig=abc',
      key: 'photos/cat.jpg',
    });

    expect(mockGetPresignedPutObjectUrl).toHaveBeenCalledWith(s3ClientSentinel, {
      bucket: 'my-bucket',
      key: 'photos/cat.jpg',
      expiresIn: 300,
      contentType: 'image/jpeg',
      metadata: { filename: 'cat.jpg', tags: JSON.stringify(['vacation', 'pets']) },
    });
  });

  it('returns 503 when org setup is not complete', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: `ORG#${USER_INFO.orgId}` },
        sk: { S: 'PROFILE' },
        auroraTenantId: { S: 'aurora-t-1' },
        setupStatus: { S: 'AURORA_TENANT_SETUP_COMPLETE' },
      },
    });

    const event = buildEvent({ body: validBody(), userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockGetAuroraS3Client).not.toHaveBeenCalled();
  });
});
