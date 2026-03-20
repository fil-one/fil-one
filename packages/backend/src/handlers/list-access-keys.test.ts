import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './list-access-keys.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function ddbItem(overrides: {
  id: string;
  keyName: string;
  accessKeyId: string;
  createdAt: string;
  status?: string;
  permissions?: string[];
  bucketScope?: string;
  buckets?: string[];
  expiresAt?: string;
}) {
  const item: Record<string, AttributeValue> = {
    pk: { S: `ORG#${USER_INFO.orgId}` },
    sk: { S: `ACCESSKEY#${overrides.id}` },
    keyName: { S: overrides.keyName },
    accessKeyId: { S: overrides.accessKeyId },
    createdAt: { S: overrides.createdAt },
    status: { S: overrides.status ?? 'active' },
  };
  if (overrides.permissions) item.permissions = { L: overrides.permissions.map((p) => ({ S: p })) };
  if (overrides.bucketScope) item.bucketScope = { S: overrides.bucketScope };
  if (overrides.buckets) item.buckets = { L: overrides.buckets.map((b) => ({ S: b })) };
  if (overrides.expiresAt) item.expiresAt = { S: overrides.expiresAt };
  return item;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('list-access-keys baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 200 with mapped key fields from DynamoDB', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'Production',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['read', 'list'],
          bucketScope: 'all',
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      keys: [
        {
          id: 'key-1',
          keyName: 'Production',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          status: 'active',
          permissions: ['read', 'list'],
          bucketScope: 'all',
          expiresAt: null,
        },
      ],
    });
  });

  it('returns bucket-scoped key with buckets list', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'Scoped Key',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['read'],
          bucketScope: 'specific',
          buckets: ['bucket-a', 'bucket-b'],
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body!);
    expect(body.keys[0]).toMatchObject({
      bucketScope: 'specific',
      buckets: ['bucket-a', 'bucket-b'],
    });
  });

  it('returns expiresAt when set', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'Expiring Key',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['read'],
          bucketScope: 'all',
          expiresAt: '2026-06-01',
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body!);
    expect(body.keys[0].expiresAt).toBe('2026-06-01');
  });

  it('returns 200 with empty array when no keys exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({ keys: [] });
  });

  it('returns multiple keys', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'Production',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['read', 'write', 'list', 'delete'],
          bucketScope: 'all',
        }),
        ddbItem({
          id: 'key-2',
          keyName: 'Dev',
          accessKeyId: 'AKIA2222',
          createdAt: '2026-02-01T00:00:00Z',
          permissions: ['read'],
          bucketScope: 'all',
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body!);
    expect(body.keys).toHaveLength(2);
    expect(body.keys[0].id).toBe('key-1');
    expect(body.keys[1].id).toBe('key-2');
  });

  it('queries DynamoDB with correct key condition', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input).toStrictEqual({
      TableName: 'UserInfoTable',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: 'ORG#org-1' },
        ':skPrefix': { S: 'ACCESSKEY#' },
      },
    });
  });

  it('adds FilterExpression when bucket query param is provided', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { bucket: 'my-bucket' },
    });
    await baseHandler(event);

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input).toStrictEqual({
      TableName: 'UserInfoTable',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      FilterExpression: 'bucketScope = :all OR contains(buckets, :bucket)',
      ExpressionAttributeValues: {
        ':pk': { S: 'ORG#org-1' },
        ':skPrefix': { S: 'ACCESSKEY#' },
        ':all': { S: 'all' },
        ':bucket': { S: 'my-bucket' },
      },
    });
  });

  it('does not add FilterExpression when no bucket query param', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    const calls = ddbMock.commandCalls(QueryCommand);
    const input = calls[0].args[0].input;
    expect(input.FilterExpression).toBeUndefined();
    expect(input.ExpressionAttributeValues).toStrictEqual({
      ':pk': { S: 'ORG#org-1' },
      ':skPrefix': { S: 'ACCESSKEY#' },
    });
  });

  it('returns mapped keys when bucket filter is applied', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'All Access',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['read', 'write'],
          bucketScope: 'all',
        }),
        ddbItem({
          id: 'key-2',
          keyName: 'Scoped',
          accessKeyId: 'AKIA2222',
          createdAt: '2026-02-01T00:00:00Z',
          permissions: ['read'],
          bucketScope: 'specific',
          buckets: ['target-bucket'],
        }),
      ],
    });

    const event = buildEvent({
      userInfo: USER_INFO,
      queryStringParameters: { bucket: 'target-bucket' },
    });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({
      keys: [
        {
          id: 'key-1',
          keyName: 'All Access',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          status: 'active',
          permissions: ['read', 'write'],
          bucketScope: 'all',
          expiresAt: null,
        },
        {
          id: 'key-2',
          keyName: 'Scoped',
          accessKeyId: 'AKIA2222',
          createdAt: '2026-02-01T00:00:00Z',
          status: 'active',
          permissions: ['read'],
          bucketScope: 'specific',
          buckets: ['target-bucket'],
          expiresAt: null,
        },
      ],
    });
  });
});
