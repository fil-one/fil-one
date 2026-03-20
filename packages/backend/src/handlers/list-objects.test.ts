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
const mockListObjects = vi.fn();

vi.mock('../lib/aurora-s3-client.js', () => ({
  getAuroraS3Credentials: (...args: unknown[]) => mockGetAuroraS3Credentials(...args),
  listObjects: (...args: unknown[]) => mockListObjects(...args),
}));

process.env.FILONE_STAGE = 'test';
process.env.AURORA_S3_GATEWAY_URL = 'https://s3.dev.aur.lu';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './list-objects.js';
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

describe('list-objects baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 200 with objects from S3', async () => {
    ddbMock.on(GetItemCommand, { TableName: 'UploadsTable' }).resolves(bucketRecord());
    ddbMock
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraS3Credentials.mockResolvedValue({
      accessKeyId: 'AKIA_CONSOLE',
      secretAccessKey: 's3_secret',
    });
    mockListObjects.mockResolvedValue({
      objects: [
        { key: 'photos/cat.jpg', sizeBytes: 1024, lastModified: '2026-01-01T00:00:00.000Z' },
      ],
      isTruncated: false,
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({
      objects: [
        { key: 'photos/cat.jpg', sizeBytes: 1024, lastModified: '2026-01-01T00:00:00.000Z' },
      ],
      isTruncated: false,
    });

    expect(mockListObjects).toHaveBeenCalledWith({
      endpointUrl: 'https://s3.dev.aur.lu',
      credentials: { accessKeyId: 'AKIA_CONSOLE', secretAccessKey: 's3_secret' },
      bucket: 'my-bucket',
      prefix: undefined,
      delimiter: undefined,
      maxKeys: undefined,
      continuationToken: undefined,
    });
  });

  it('returns 400 when bucket name is missing from path', async () => {
    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when bucket is not found', async () => {
    ddbMock.on(GetItemCommand, { TableName: 'UploadsTable' }).resolves({ Item: undefined });

    const event = buildEvent({ userInfo: USER_INFO });
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

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(503);
    expect(mockGetAuroraS3Credentials).not.toHaveBeenCalled();
  });

  it('passes pagination parameters through to listObjects', async () => {
    ddbMock.on(GetItemCommand, { TableName: 'UploadsTable' }).resolves(bucketRecord());
    ddbMock
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraS3Credentials.mockResolvedValue({
      accessKeyId: 'AKIA_CONSOLE',
      secretAccessKey: 's3_secret',
    });
    mockListObjects.mockResolvedValue({
      objects: [],
      nextToken: 'next-page',
      isTruncated: true,
    });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { prefix: 'photos/', maxKeys: '10', nextToken: 'token-1' },
    });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    expect(mockListObjects).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: 'photos/',
        maxKeys: 10,
        continuationToken: 'token-1',
      }),
    );

    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({
      objects: [],
      nextToken: 'next-page',
      isTruncated: true,
    });
  });
});
