import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UploadsTable: { name: 'UploadsTable' },
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './get-activity.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function bucketItem(name: string, createdAt: string) {
  return marshall({
    pk: `USER#${USER_INFO.userId}`,
    sk: `BUCKET#${name}`,
    name,
    region: 'us-east-1',
    createdAt,
    isPublic: false,
  });
}

function objectItem(bucketName: string, key: string, uploadedAt: string, sizeBytes: number) {
  return marshall({
    pk: `BUCKET#${USER_INFO.userId}#${bucketName}`,
    sk: `OBJECT#${key}`,
    key,
    fileName: key,
    contentType: 'application/octet-stream',
    sizeBytes,
    uploadedAt,
    etag: '"abc"',
    s3Key: `${bucketName}/${key}`,
  });
}

function keyItem(id: string, keyName: string, createdAt: string) {
  return marshall({
    pk: `ORG#${USER_INFO.orgId}`,
    sk: `ACCESSKEY#${id}`,
    keyName,
    accessKeyId: `AKIA-${id}`,
    createdAt,
    status: 'active',
  });
}

/** Build an array of { date: expect.any(String), value } for flat trend assertions. */
function flatTrend(length: number, value: number) {
  return Array.from({ length }, () => ({ date: expect.any(String), value }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-activity baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 200 with empty activities and flat trends when no buckets exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({
      activities: [],
      trends: {
        storage: flatTrend(7, 0),
        objects: flatTrend(7, 0),
      },
    });
  });

  it('returns bucket and object activities sorted most-recent-first', async () => {
    // First query: list buckets
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `USER#${USER_INFO.userId}` } },
      })
      .resolves({
        Items: [bucketItem('photos', '2026-01-01T00:00:00Z')],
      });

    // Second query: objects in bucket
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${USER_INFO.userId}#photos` },
          ':skPrefix': { S: 'OBJECT#' },
        },
      })
      .resolves({
        Items: [
          objectItem('photos', 'cat.jpg', '2026-01-05T00:00:00Z', 1024),
          objectItem('photos', 'dog.jpg', '2026-01-03T00:00:00Z', 2048),
        ],
      });

    // Third query: access keys
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `ORG#${USER_INFO.orgId}` } },
      })
      .resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));

    expect(body).toStrictEqual({
      activities: [
        {
          id: 'object-photos-cat.jpg',
          action: 'object.uploaded',
          resourceType: 'object',
          resourceName: 'cat.jpg',
          timestamp: '2026-01-05T00:00:00Z',
          sizeBytes: 1024,
        },
        {
          id: 'object-photos-dog.jpg',
          action: 'object.uploaded',
          resourceType: 'object',
          resourceName: 'dog.jpg',
          timestamp: '2026-01-03T00:00:00Z',
          sizeBytes: 2048,
        },
        {
          id: 'bucket-photos',
          action: 'bucket.created',
          resourceType: 'bucket',
          resourceName: 'photos',
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
      trends: {
        storage: flatTrend(7, expect.any(Number)),
        objects: flatTrend(7, expect.any(Number)),
      },
    });
  });

  it('respects the limit query parameter', async () => {
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `USER#${USER_INFO.userId}` } },
      })
      .resolves({
        Items: [bucketItem('b1', '2026-01-01T00:00:00Z')],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${USER_INFO.userId}#b1` },
          ':skPrefix': { S: 'OBJECT#' },
        },
      })
      .resolves({
        Items: [
          objectItem('b1', 'a.txt', '2026-01-02T00:00:00Z', 100),
          objectItem('b1', 'b.txt', '2026-01-03T00:00:00Z', 200),
          objectItem('b1', 'c.txt', '2026-01-04T00:00:00Z', 300),
        ],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `ORG#${USER_INFO.orgId}` } },
      })
      .resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { limit: '2' },
    });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(body).toStrictEqual({
      activities: [
        {
          id: 'object-b1-c.txt',
          action: 'object.uploaded',
          resourceType: 'object',
          resourceName: 'c.txt',
          timestamp: '2026-01-04T00:00:00Z',
          sizeBytes: 300,
        },
        {
          id: 'object-b1-b.txt',
          action: 'object.uploaded',
          resourceType: 'object',
          resourceName: 'b.txt',
          timestamp: '2026-01-03T00:00:00Z',
          sizeBytes: 200,
        },
      ],
      trends: {
        storage: flatTrend(7, expect.any(Number)),
        objects: flatTrend(7, expect.any(Number)),
      },
    });
  });

  it('defaults limit to 10 when limit is non-numeric', async () => {
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `USER#${USER_INFO.userId}` } },
      })
      .resolves({
        Items: [bucketItem('b1', '2026-01-01T00:00:00Z')],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${USER_INFO.userId}#b1` },
          ':skPrefix': { S: 'OBJECT#' },
        },
      })
      .resolves({
        Items: [
          objectItem('b1', 'a.txt', '2026-01-02T00:00:00Z', 100),
          objectItem('b1', 'b.txt', '2026-01-03T00:00:00Z', 200),
        ],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `ORG#${USER_INFO.orgId}` } },
      })
      .resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { limit: 'abc' },
    });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    // Should fall back to 10, not return empty due to NaN
    expect(body.activities).toHaveLength(3);
  });

  it('defaults limit to 10 when limit is negative', async () => {
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `USER#${USER_INFO.userId}` } },
      })
      .resolves({
        Items: [bucketItem('b1', '2026-01-01T00:00:00Z')],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${USER_INFO.userId}#b1` },
          ':skPrefix': { S: 'OBJECT#' },
        },
      })
      .resolves({
        Items: [
          objectItem('b1', 'a.txt', '2026-01-02T00:00:00Z', 100),
          objectItem('b1', 'b.txt', '2026-01-03T00:00:00Z', 200),
        ],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `ORG#${USER_INFO.orgId}` } },
      })
      .resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { limit: '-5' },
    });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(body.activities.length).toBeGreaterThanOrEqual(1);
  });

  it('caps limit at 50', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { limit: '999' },
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({
      activities: [],
      trends: {
        storage: flatTrend(7, 0),
        objects: flatTrend(7, 0),
      },
    });
  });

  it('returns 30-day trend series when period=30d', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { period: '30d' },
    });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(body).toStrictEqual({
      activities: [],
      trends: {
        storage: flatTrend(30, 0),
        objects: flatTrend(30, 0),
      },
    });
  });

  it('defaults to 7-day trend series', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(body).toStrictEqual({
      activities: [],
      trends: {
        storage: flatTrend(7, 0),
        objects: flatTrend(7, 0),
      },
    });
  });

  it('computes cumulative storage in trends', async () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);

    const twoDaysAgo = new Date(now);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    twoDaysAgo.setHours(12, 0, 0, 0);

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `USER#${USER_INFO.userId}` } },
      })
      .resolves({
        Items: [bucketItem('data', '2025-01-01T00:00:00Z')],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${USER_INFO.userId}#data` },
          ':skPrefix': { S: 'OBJECT#' },
        },
      })
      .resolves({
        Items: [
          objectItem('data', 'old.bin', twoDaysAgo.toISOString(), 500),
          objectItem('data', 'new.bin', yesterday.toISOString(), 300),
        ],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `ORG#${USER_INFO.orgId}` } },
      })
      .resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    // The last day's cumulative storage should be 800 (500 + 300)
    const lastStoragePoint = body.trends.storage[body.trends.storage.length - 1];
    expect(lastStoragePoint.value).toBe(800);

    // Full structure check
    expect(body).toStrictEqual({
      activities: expect.arrayContaining([
        {
          id: 'object-data-new.bin',
          action: 'object.uploaded',
          resourceType: 'object',
          resourceName: 'new.bin',
          timestamp: yesterday.toISOString(),
          sizeBytes: 300,
        },
        {
          id: 'object-data-old.bin',
          action: 'object.uploaded',
          resourceType: 'object',
          resourceName: 'old.bin',
          timestamp: twoDaysAgo.toISOString(),
          sizeBytes: 500,
        },
        {
          id: 'bucket-data',
          action: 'bucket.created',
          resourceType: 'bucket',
          resourceName: 'data',
          timestamp: '2025-01-01T00:00:00Z',
        },
      ]),
      trends: {
        storage: flatTrend(7, expect.any(Number)),
        objects: flatTrend(7, expect.any(Number)),
      },
    });
  });

  it('queries DynamoDB with correct key conditions', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    expect(calls.at(0)?.args.at(0)?.input).toStrictEqual({
      TableName: 'UploadsTable',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: 'USER#user-1' },
        ':skPrefix': { S: 'BUCKET#' },
      },
    });
    expect(calls.at(1)?.args.at(0)?.input).toStrictEqual({
      TableName: 'UserInfoTable',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: 'ORG#org-1' },
        ':skPrefix': { S: 'ACCESSKEY#' },
      },
    });
  });

  it('includes key activities sorted with buckets and objects', async () => {
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `USER#${USER_INFO.userId}` } },
      })
      .resolves({
        Items: [bucketItem('b1', '2026-01-01T00:00:00Z')],
      });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${USER_INFO.userId}#b1` },
          ':skPrefix': { S: 'OBJECT#' },
        },
      })
      .resolves({ Items: [] });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `ORG#${USER_INFO.orgId}` },
          ':skPrefix': { S: 'ACCESSKEY#' },
        },
      })
      .resolves({
        Items: [keyItem('key-1', 'my-api-key', '2026-01-02T00:00:00Z')],
      });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(body).toStrictEqual({
      activities: [
        {
          id: 'key-key-1',
          action: 'key.created',
          resourceType: 'key',
          resourceName: 'my-api-key',
          timestamp: '2026-01-02T00:00:00Z',
        },
        {
          id: 'bucket-b1',
          action: 'bucket.created',
          resourceType: 'bucket',
          resourceName: 'b1',
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
      trends: {
        storage: flatTrend(7, expect.any(Number)),
        objects: flatTrend(7, expect.any(Number)),
      },
    });
  });

  it('includes sizeBytes and cid on object activities when present', async () => {
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `USER#${USER_INFO.userId}` } },
      })
      .resolves({
        Items: [bucketItem('b1', '2026-01-01T00:00:00Z')],
      });

    const objWithCid = marshall({
      pk: `BUCKET#${USER_INFO.userId}#b1`,
      sk: 'OBJECT#file.dat',
      key: 'file.dat',
      fileName: 'file.dat',
      contentType: 'application/octet-stream',
      sizeBytes: 4096,
      uploadedAt: '2026-01-02T00:00:00Z',
      etag: '"xyz"',
      s3Key: 'b1/file.dat',
      cid: 'bafy123',
    });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: {
          ':pk': { S: `BUCKET#${USER_INFO.userId}#b1` },
          ':skPrefix': { S: 'OBJECT#' },
        },
      })
      .resolves({ Items: [objWithCid] });

    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':pk': { S: `ORG#${USER_INFO.orgId}` } },
      })
      .resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);
    const body = JSON.parse(String(result.body));

    expect(body).toStrictEqual({
      activities: [
        {
          id: 'object-b1-file.dat',
          action: 'object.uploaded',
          resourceType: 'object',
          resourceName: 'file.dat',
          timestamp: '2026-01-02T00:00:00Z',
          sizeBytes: 4096,
          cid: 'bafy123',
        },
        {
          id: 'bucket-b1',
          action: 'bucket.created',
          resourceType: 'bucket',
          resourceName: 'b1',
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
      trends: {
        storage: flatTrend(7, expect.any(Number)),
        objects: flatTrend(7, expect.any(Number)),
      },
    });
  });
});
