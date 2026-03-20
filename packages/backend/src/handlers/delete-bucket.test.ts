import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { NoSuchBucket } from '@aws-sdk/client-s3';
import { FINAL_SETUP_STATUS } from '../lib/org-setup-status.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockGetAuroraS3Credentials = vi.fn();
const mockListObjects = vi.fn();
const mockDeleteBucket = vi.fn();

vi.mock('../lib/aurora-s3-client.js', () => ({
  getAuroraS3Credentials: (...args: unknown[]) => mockGetAuroraS3Credentials(...args),
  listObjects: (...args: unknown[]) => mockListObjects(...args),
  deleteBucket: (...args: unknown[]) => mockDeleteBucket(...args),
}));

process.env.FILONE_STAGE = 'test';
process.env.AURORA_S3_GATEWAY_URL = 'https://s3.dev.aur.lu';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './delete-bucket.js';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('delete-bucket baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 204 after deleting an empty bucket', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraS3Credentials.mockResolvedValue({
      accessKeyId: 'AKIA_CONSOLE',
      secretAccessKey: 's3_secret',
    });
    mockListObjects.mockResolvedValue({ objects: [], isTruncated: false });
    mockDeleteBucket.mockResolvedValue(undefined);

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(204);
    expect(mockDeleteBucket).toHaveBeenCalledWith(
      'https://s3.dev.aur.lu',
      { accessKeyId: 'AKIA_CONSOLE', secretAccessKey: 's3_secret' },
      'my-bucket',
    );
  });

  it('returns 404 when S3 throws NoSuchBucket', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraS3Credentials.mockResolvedValue({
      accessKeyId: 'AKIA_CONSOLE',
      secretAccessKey: 's3_secret',
    });
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
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraS3Credentials.mockResolvedValue({
      accessKeyId: 'AKIA_CONSOLE',
      secretAccessKey: 's3_secret',
    });
    mockListObjects.mockResolvedValue({
      objects: [{ key: 'file.txt', sizeBytes: 100, lastModified: '2026-01-01T00:00:00.000Z' }],
      isTruncated: false,
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(409);
    expect(mockDeleteBucket).not.toHaveBeenCalled();
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

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockGetAuroraS3Credentials).not.toHaveBeenCalled();
  });
});
