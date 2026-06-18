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
  region?: string;
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
  if (overrides.region) item.region = { S: overrides.region };
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
          permissions: ['GetObject', 'ListBucket'],
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
          permissions: ['GetObject', 'ListBucket'],
          bucketScope: 'all',
          region: 'eu-west-1',
          expiresAt: null,
        },
      ],
    });
  });

  it('filters out legacy basic tokens, returning [] until the row is backfilled', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-legacy',
          keyName: 'Legacy Basic Key',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          // Un-migrated legacy row: `permissions` holds basic tokens, not S3 actions.
          permissions: ['read', 'write', 'list', 'delete'],
          bucketScope: 'all',
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body!);
    expect(body.keys[0].permissions).toStrictEqual([]);
  });

  it('passes through S3-action permissions from a migrated row', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-migrated',
          keyName: 'Migrated Key',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          // `permissions` may include extra values; only known S3 actions survive.
          permissions: ['GetObject', 'PutObject', 'read'],
          bucketScope: 'all',
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body!);
    expect(body.keys[0].permissions).toStrictEqual(['GetObject', 'PutObject']);
  });

  it('returns bucket-scoped key with buckets list', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'Scoped Key',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['GetObject'],
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

  it('returns the persisted region from the row', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'FTH Key',
          accessKeyId: 'AKIAFTH',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['GetObject'],
          bucketScope: 'all',
          region: 'us-east-1',
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body!);
    expect(body.keys[0].region).toBe('us-east-1');
  });

  it('falls back to S3_REGION (eu-west-1) for legacy rows without region', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-legacy',
          keyName: 'Legacy Key',
          accessKeyId: 'AKIALEGACY',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['GetObject'],
          bucketScope: 'all',
          // region attribute deliberately omitted
        }),
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    const body = JSON.parse(result.body!);
    expect(body.keys[0].region).toBe('eu-west-1');
  });

  it('returns expiresAt when set', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem({
          id: 'key-1',
          keyName: 'Expiring Key',
          accessKeyId: 'AKIA1111',
          createdAt: '2026-01-01T00:00:00Z',
          permissions: ['GetObject'],
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
          permissions: ['GetObject', 'PutObject', 'ListBucket', 'DeleteObject'],
          bucketScope: 'all',
        }),
        ddbItem({
          id: 'key-2',
          keyName: 'Dev',
          accessKeyId: 'AKIA2222',
          createdAt: '2026-02-01T00:00:00Z',
          permissions: ['GetObject'],
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
          permissions: ['GetObject', 'PutObject'],
          bucketScope: 'all',
        }),
        ddbItem({
          id: 'key-2',
          keyName: 'Scoped',
          accessKeyId: 'AKIA2222',
          createdAt: '2026-02-01T00:00:00Z',
          permissions: ['GetObject'],
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
          permissions: ['GetObject', 'PutObject'],
          bucketScope: 'all',
          region: 'eu-west-1',
          expiresAt: null,
        },
        {
          id: 'key-2',
          keyName: 'Scoped',
          accessKeyId: 'AKIA2222',
          createdAt: '2026-02-01T00:00:00Z',
          status: 'active',
          permissions: ['GetObject'],
          bucketScope: 'specific',
          buckets: ['target-bucket'],
          region: 'eu-west-1',
          expiresAt: null,
        },
      ],
    });
  });
});
