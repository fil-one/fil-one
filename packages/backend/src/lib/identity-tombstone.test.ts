import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { classifyIdentityRow, isIdentityTombstoned } from './identity-tombstone.js';

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

describe('classifyIdentityRow', () => {
  it('reads a live identity as live', () => {
    expect(classifyIdentityRow({ userId: { S: 'user-1' } })).toBe('live');
  });

  it('reads an armed row that still has userId as deleting', () => {
    // applyDeletionGuards sets deleted/deletedAt at confirm time and leaves
    // userId alone; the purge REMOVEs it later. That gap IS the in-flight state.
    expect(classifyIdentityRow({ deleted: { BOOL: true }, userId: { S: 'user-1' } })).toBe(
      'deleting',
    );
  });

  it('reads the post-purge shape as deleted', () => {
    expect(classifyIdentityRow({ deleted: { BOOL: true } })).toBe('deleted');
  });

  it('reads a present row with neither deleted nor userId as deleted', () => {
    // Without this, `if (!armed) return hasUserId ? 'live' : 'deleted'` reduces to
    // `return 'live'` with nothing failing — which silently drops the `!userId`
    // half of the OR this classifier replaced.
    expect(classifyIdentityRow({ pk: { S: 'SUB#x' }, sk: { S: 'IDENTITY' } })).toBe('deleted');
  });

  it('reads an ABSENT row as deleted, never deleting', () => {
    // The confirm handler upserts this row, so no row at all means the identity
    // never existed — there is no evidence of an in-flight teardown to report.
    // Getting this wrong would tell a stranger their deletion was running.
    expect(classifyIdentityRow(undefined)).toBe('deleted');
  });

  it('keeps isIdentityTombstoned true for BOTH non-live states', async () => {
    // The OR this replaced was deliberate: isIdentityTombstoned is the post-write
    // resurrection check, and a writer must compensate whether the teardown is in
    // flight or already finished. Narrowing it to the completed case would
    // silently reopen that window.
    ddbMock
      .on(GetItemCommand)
      .resolves({ Item: { deleted: { BOOL: true }, userId: { S: 'user-1' } } });
    expect(await isIdentityTombstoned(USER_INFO)).toBe(true);

    ddbMock.reset();
    ddbMock.on(GetItemCommand).resolves({ Item: { deleted: { BOOL: true } } });
    expect(await isIdentityTombstoned(USER_INFO)).toBe(true);
  });
});
