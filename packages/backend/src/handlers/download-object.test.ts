import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
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
const mockGetPresignedGetObjectUrl = vi.fn();

vi.mock('../lib/aurora-s3-client.js', () => ({
  getAuroraS3Credentials: (...args: unknown[]) => mockGetAuroraS3Credentials(...args),
  getPresignedGetObjectUrl: (...args: unknown[]) => mockGetPresignedGetObjectUrl(...args),
}));

process.env.FILONE_STAGE = 'test';
process.env.AURORA_S3_GATEWAY_URL = 'https://s3.dev.aur.lu';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './download-object.js';
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

describe('download-object baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 200 with presigned GET URL from Aurora S3', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraS3Credentials.mockResolvedValue({
      accessKeyId: 'AKIA_CONSOLE',
      secretAccessKey: 's3_secret',
    });
    mockGetPresignedGetObjectUrl.mockResolvedValue(
      'https://s3.dev.aur.lu/my-bucket/photos/cat.jpg?sig=get123',
    );

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { key: 'photos/cat.jpg' },
      rawPath: '/api/buckets/my-bucket/objects/download',
    });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({
      url: 'https://s3.dev.aur.lu/my-bucket/photos/cat.jpg?sig=get123',
    });

    expect(mockGetAuroraS3Credentials).toHaveBeenCalledWith('test', 'aurora-t-1');
    expect(mockGetPresignedGetObjectUrl).toHaveBeenCalledWith({
      endpointUrl: 'https://s3.dev.aur.lu',
      credentials: { accessKeyId: 'AKIA_CONSOLE', secretAccessKey: 's3_secret' },
      bucket: 'my-bucket',
      key: 'photos/cat.jpg',
      expiresIn: 300,
    });
  });

  it('returns 400 when bucket name is missing from path', async () => {
    const event = buildEvent({ userInfo: USER_INFO, queryStringParameters: { key: 'test.txt' } });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when object key is missing from query', async () => {
    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
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

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { key: 'photos/cat.jpg' },
    });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockGetAuroraS3Credentials).not.toHaveBeenCalled();
  });
});
