import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './list-rag-api-keys.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

const USER_INFO = { userId: 'user-1', orgId: 'org-1', emailVerified: true };

function keyItem(overrides: Record<string, unknown> = {}) {
  return marshall({
    pk: 'ORG#org-1',
    sk: 'RAGKEY#key-1',
    keyName: 'ci key',
    keyPrefix: 'sk_rag_AbC12',
    tokenHash: 'a'.repeat(64),
    bucketScope: 'all',
    createdBy: 'user-1',
    creatorEmail: 'dev@example.com',
    createdAt: '2026-07-01T00:00:00Z',
    ...overrides,
  });
}

describe('list-rag-api-keys baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('queries only the caller org partition with the RAGKEY prefix', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const query = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(query.ExpressionAttributeValues).toEqual({
      ':pk': { S: 'ORG#org-1' },
      ':skPrefix': { S: 'RAGKEY#' },
    });
  });

  it('maps records to the API shape without ever exposing tokenHash', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        keyItem({ lastUsedAt: '2026-07-05T00:00:00Z' }),
        keyItem({
          sk: 'RAGKEY#key-2',
          keyName: 'scoped',
          bucketScope: 'specific',
          buckets: [{ region: 'eu-west-1', name: 'docs' }],
          createdAt: '2026-07-02T00:00:00Z',
        }),
      ],
    });

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    expect(result.statusCode).toBe(200);
    const { keys } = JSON.parse(result.body ?? '{}');
    // Sorted newest-first.
    expect(keys.map((k: { id: string }) => k.id)).toEqual(['key-2', 'key-1']);
    expect(keys[1]).toEqual({
      id: 'key-1',
      keyName: 'ci key',
      keyPrefix: 'sk_rag_AbC12',
      bucketScope: 'all',
      createdAt: '2026-07-01T00:00:00Z',
      creatorEmail: 'dev@example.com',
      lastUsedAt: '2026-07-05T00:00:00Z',
    });
    expect(keys[0].buckets).toEqual([{ region: 'eu-west-1', name: 'docs' }]);
    expect(result.body).not.toContain('tokenHash');
    expect(result.body).not.toContain('a'.repeat(64));
  });

  it('returns an empty list for an org with no keys', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? '{}')).toEqual({ keys: [] });
  });
});
