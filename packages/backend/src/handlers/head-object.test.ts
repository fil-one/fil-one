import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { NoSuchBucket, NotFound } from '@aws-sdk/client-s3';
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
const mockHeadObject = vi.fn();
const mockGetObjectRetention = vi.fn();

vi.mock('../lib/aurora-s3-client.js', () => ({
  getAuroraS3Credentials: (...args: unknown[]) => mockGetAuroraS3Credentials(...args),
  headObject: (...args: unknown[]) => mockHeadObject(...args),
  getObjectRetention: (...args: unknown[]) => mockGetObjectRetention(...args),
}));

process.env.FILONE_STAGE = 'test';
process.env.AURORA_S3_GATEWAY_URL = 'https://s3.dev.aur.lu';

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './head-object.js';
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

describe('head-object baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 400 when object key is missing from query', async () => {
    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body as string) as { message: string };
    expect(body.message).toBeTruthy();
  });

  it('returns 404 when S3 throws NoSuchBucket', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraS3Credentials.mockResolvedValue({
      accessKeyId: 'AKIA_CONSOLE',
      secretAccessKey: 's3_secret',
    });
    mockHeadObject.mockRejectedValue(
      new NoSuchBucket({ message: 'The specified bucket does not exist', $metadata: {} }),
    );
    mockGetObjectRetention.mockResolvedValue(null);

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { key: 'photos/cat.jpg' },
    });
    event.pathParameters = { name: 'no-such-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({ message: 'Bucket not found' });
  });

  it('returns 404 when S3 throws NotFound for missing object key', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraS3Credentials.mockResolvedValue({
      accessKeyId: 'AKIA_CONSOLE',
      secretAccessKey: 's3_secret',
    });
    mockHeadObject.mockRejectedValue(new NotFound({ message: 'Not Found', $metadata: {} }));
    mockGetObjectRetention.mockResolvedValue(null);

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { key: 'no-such-key.txt' },
    });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({ message: 'Object not found' });
  });

  it('returns 200 with object metadata and retention on success', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraS3Credentials.mockResolvedValue({
      accessKeyId: 'AKIA_CONSOLE',
      secretAccessKey: 's3_secret',
    });
    mockHeadObject.mockResolvedValue({
      key: 'photos/cat.jpg',
      sizeBytes: 12345,
      lastModified: '2026-01-15T10:30:00.000Z',
      etag: '"abc123"',
      contentType: 'image/jpeg',
      metadata: { description: 'A cat photo' },
      filCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3okuber3gxmk6e',
    });
    mockGetObjectRetention.mockResolvedValue({
      mode: 'COMPLIANCE',
      retainUntilDate: '2026-03-29T00:00:00.000Z',
    });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { key: 'photos/cat.jpg' },
      rawPath: '/api/buckets/my-bucket/objects/metadata',
    });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({
      key: 'photos/cat.jpg',
      sizeBytes: 12345,
      lastModified: '2026-01-15T10:30:00.000Z',
      etag: '"abc123"',
      contentType: 'image/jpeg',
      metadata: { description: 'A cat photo' },
      filCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3okuber3gxmk6e',
      retention: {
        mode: 'COMPLIANCE',
        retainUntilDate: '2026-03-29T00:00:00.000Z',
      },
    });

    expect(mockGetAuroraS3Credentials).toHaveBeenCalledWith('test', 'aurora-t-1');
    expect(mockHeadObject).toHaveBeenCalledWith(
      'https://s3.dev.aur.lu',
      { accessKeyId: 'AKIA_CONSOLE', secretAccessKey: 's3_secret' },
      'my-bucket',
      'photos/cat.jpg',
    );
  });

  it('returns 200 without fil fields when object is not yet offloaded', async () => {
    ddbMock.on(GetItemCommand).resolves(orgProfileWithTenant('aurora-t-1'));
    mockGetAuroraS3Credentials.mockResolvedValue({
      accessKeyId: 'AKIA_CONSOLE',
      secretAccessKey: 's3_secret',
    });
    mockHeadObject.mockResolvedValue({
      key: 'docs/readme.txt',
      sizeBytes: 256,
      lastModified: '2026-02-01T08:00:00.000Z',
      contentType: 'text/plain',
      metadata: {},
    });
    mockGetObjectRetention.mockResolvedValue(null);

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { key: 'docs/readme.txt' },
    });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body).toStrictEqual({
      key: 'docs/readme.txt',
      sizeBytes: 256,
      lastModified: '2026-02-01T08:00:00.000Z',
      contentType: 'text/plain',
      metadata: {},
    });
  });
});
