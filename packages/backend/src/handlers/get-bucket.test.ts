import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UploadsTable: { name: 'UploadsTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './get-bucket.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function bucketItem(name: string, region: string, createdAt: string, isPublic = false) {
  return {
    pk: { S: `USER#${USER_INFO.userId}` },
    sk: { S: `BUCKET#${name}` },
    name: { S: name },
    region: { S: region },
    createdAt: { S: createdAt },
    isPublic: { BOOL: isPublic },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-bucket baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 200 with bucket data', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: bucketItem('my-bucket', 'eu-west-1', '2026-01-15T10:00:00Z'),
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'my-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      bucket: {
        name: 'my-bucket',
        region: 'eu-west-1',
        createdAt: '2026-01-15T10:00:00Z',
        objectCount: 0,
        sizeBytes: 0,
        isPublic: false,
      },
    });
  });

  it('returns 404 when bucket does not exist', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'nonexistent-bucket' };
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({ message: 'Bucket not found' });
  });

  it('returns 400 when bucket name is missing', async () => {
    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({ message: 'Bucket name is required' });
  });

  it('queries DynamoDB with correct key', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'test-bucket' };
    await baseHandler(event);

    const calls = ddbMock.commandCalls(GetItemCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input).toStrictEqual({
      TableName: 'UploadsTable',
      Key: {
        pk: { S: 'USER#user-1' },
        sk: { S: 'BUCKET#test-bucket' },
      },
    });
  });

  it('returns isPublic true when bucket is public', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: bucketItem('public-bucket', 'eu-west-1', '2026-01-15T10:00:00Z', true),
    });

    const event = buildEvent({ userInfo: USER_INFO });
    event.pathParameters = { name: 'public-bucket' };
    const result = await baseHandler(event);

    const body = JSON.parse(result.body!);
    expect(body.bucket.isPublic).toBe(true);
  });
});
