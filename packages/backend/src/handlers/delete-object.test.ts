import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { FINAL_SETUP_STATUS } from '../lib/org-setup-status.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UploadsTable: { name: 'UploadsTable' },
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockGetAuroraS3Credentials = vi.fn();
const mockDeleteObject = vi.fn();

vi.mock('../lib/aurora-s3-client.js', () => ({
  getAuroraS3Credentials: (...args: unknown[]) => mockGetAuroraS3Credentials(...args),
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
}));

process.env.FILONE_STAGE = 'test';
process.env.AURORA_S3_GATEWAY_URL = 'https://s3.dev.aur.lu';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './delete-object.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function bucketRecord() {
  return {
    Item: marshall({ pk: `USER#${USER_INFO.userId}`, sk: 'BUCKET#my-bucket' }),
  };
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

describe('delete-object baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 204 after deleting via Aurora S3 Gateway', async () => {
    ddbMock.on(GetItemCommand, { TableName: 'UploadsTable' }).resolves(bucketRecord());
    ddbMock
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraS3Credentials.mockResolvedValue({
      accessKeyId: 'AKIA_CONSOLE',
      secretAccessKey: 's3_secret',
    });
    mockDeleteObject.mockResolvedValue(undefined);

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { key: 'photos/cat.jpg' },
      rawPath: '/api/buckets/my-bucket/objects',
    });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(204);

    expect(mockGetAuroraS3Credentials).toHaveBeenCalledWith('test', 'aurora-t-1');
    expect(mockDeleteObject).toHaveBeenCalledWith(
      'https://s3.dev.aur.lu',
      { accessKeyId: 'AKIA_CONSOLE', secretAccessKey: 's3_secret' },
      'my-bucket',
      'photos/cat.jpg',
    );
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

  it('returns 404 when bucket is not found', async () => {
    ddbMock.on(GetItemCommand, { TableName: 'UploadsTable' }).resolves({ Item: undefined });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { key: 'test.txt' },
    });
    event.pathParameters = { name: 'no-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(404);
  });

  it('returns 503 when org setup is not complete', async () => {
    ddbMock.on(GetItemCommand, { TableName: 'UploadsTable' }).resolves(bucketRecord());
    ddbMock.on(GetItemCommand, { TableName: 'UserInfoTable' }).resolves({
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
