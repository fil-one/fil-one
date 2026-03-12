import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';

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

function ddbItem(id: string, keyName: string, accessKeyId: string, createdAt: string) {
  return {
    pk: { S: `ORG#${USER_INFO.orgId}` },
    sk: { S: `ACCESSKEY#${id}` },
    keyName: { S: keyName },
    accessKeyId: { S: accessKeyId },
    createdAt: { S: createdAt },
    status: { S: 'active' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('list-access-keys baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 200 with keys array', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        ddbItem('key-1', 'Production', 'AKIA1111', '2026-01-01T00:00:00Z'),
        ddbItem('key-2', 'Dev', 'AKIA2222', '2026-02-01T00:00:00Z'),
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
        },
        {
          id: 'key-2',
          keyName: 'Dev',
          accessKeyId: 'AKIA2222',
          createdAt: '2026-02-01T00:00:00Z',
          status: 'active',
        },
      ],
    });
  });

  it('returns 200 with empty array when no keys exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body!);
    expect(body).toStrictEqual({ keys: [] });
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
});
