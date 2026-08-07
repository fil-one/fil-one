import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { isIdentityTombstoned } from './identity-tombstone.js';

const USER_INFO = { sub: 'auth0|sub-1' };

describe('isIdentityTombstoned', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
  });

  it('returns false for a live identity', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: { userId: { S: 'user-1' } } });

    expect(await isIdentityTombstoned(USER_INFO)).toBe(false);
  });

  it('returns true when the tombstone is armed', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolves({ Item: { userId: { S: 'user-1' }, deleted: { BOOL: true } } });

    expect(await isIdentityTombstoned(USER_INFO)).toBe(true);
  });

  it('returns true when the row is missing', async () => {
    // The deletion-confirm handler upserts the SUB# row, so an absent row means
    // the identity never existed.
    ddbMock.on(GetItemCommand).resolves({});

    expect(await isIdentityTombstoned(USER_INFO)).toBe(true);
  });

  it('returns true for the post-purge shape (userId REMOVEd, deleted retained)', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: { deleted: { BOOL: true } } });

    expect(await isIdentityTombstoned(USER_INFO)).toBe(true);
  });

  it('reads the SUB# identity row consistently', async () => {
    // The auth middleware's earlier gate ran on an eventually-consistent read;
    // a stale read here would defeat the whole verify-after-write scheme.
    ddbMock.on(GetItemCommand).resolves({ Item: { userId: { S: 'user-1' } } });

    await isIdentityTombstoned(USER_INFO);

    const input = ddbMock.commandCalls(GetItemCommand)[0].args[0].input;
    expect(input.TableName).toBe('UserInfoTable');
    expect(input.ConsistentRead).toBe(true);
    expect(input.Key).toStrictEqual({ pk: { S: 'SUB#auth0|sub-1' }, sk: { S: 'IDENTITY' } });
  });
});
