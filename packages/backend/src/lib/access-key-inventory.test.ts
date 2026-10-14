import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({
  Resource: { UserInfoTable: { name: 'UserInfoTable' } },
}));

const ddbMock = mockClient(DynamoDBClient);

import {
  countAccessKeysInScope,
  getAccessKeysInScope,
  isAccessKeyExpired,
} from './access-key-inventory.ts';

function row(id: string, createdBy?: string, recovered?: boolean, expiresAt?: string) {
  return {
    sk: { S: `ACCESSKEY#${id}` },
    keyName: { S: `Key ${id}` },
    accessKeyId: { S: `AKIA${id}` },
    createdAt: { S: '2026-01-01T00:00:00Z' },
    status: { S: 'active' },
    permissions: { L: [{ S: 'read' }] },
    bucketScope: { S: 'all' },
    ...(createdBy ? { createdBy: { S: createdBy } } : {}),
    ...(recovered ? { recovered: { BOOL: true } } : {}),
    ...(expiresAt ? { expiresAt: { S: expiresAt } } : {}),
  };
}

describe('getAccessKeysInScope', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('returns every row under keys.manage_all, mapped to AccessKey', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row('1', 'user-1'), row('2', 'user-2')] });

    const keys = await getAccessKeysInScope('org-1', { sees: 'all' });

    expect(keys).toEqual([
      expect.objectContaining({ id: '1', keyName: 'Key 1', createdBy: 'user-1' }),
      expect.objectContaining({ id: '2', keyName: 'Key 2', createdBy: 'user-2' }),
    ]);
  });

  it('returns only the caller-created rows under keys.manage_own', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [row('1', 'user-1'), row('2', 'user-2'), row('3'), row('4', 'user-1', true)],
    });

    const keys = await getAccessKeysInScope('org-1', { sees: 'own', userId: 'user-1' });

    expect(keys.map((k) => k.id)).toEqual(['1']);
  });

  it('answers empty without querying when the caller sees no keys', async () => {
    expect(await getAccessKeysInScope('org-1', { sees: 'none' })).toEqual([]);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  // A truncated page would silently drop keys the caller owns, which is the
  // bug this function exists to fix.
  it('follows every page of results', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [row('1', 'user-1'), row('2', 'user-2')],
        LastEvaluatedKey: { sk: { S: 'a' } },
      })
      .resolvesOnce({ Items: [row('3', 'user-3')] });

    const keys = await getAccessKeysInScope('org-1', { sees: 'all' });

    expect(keys.map((k) => k.id)).toEqual(['1', '2', '3']);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
  });

  it('narrows to a bucket filter via the DynamoDB FilterExpression', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await getAccessKeysInScope('org-1', { sees: 'all' }, { bucketFilter: 'target-bucket' });

    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.FilterExpression).toContain('contains(buckets, :bucket)');
    expect(input.ExpressionAttributeValues?.[':bucket']).toEqual({ S: 'target-bucket' });
  });

  it('narrows to a region filter via the DynamoDB FilterExpression', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await getAccessKeysInScope('org-1', { sees: 'all' }, { regionFilter: 'us-east-1' });

    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.FilterExpression).toBe('#region = :region');
    expect(input.ExpressionAttributeValues?.[':region']).toEqual({ S: 'us-east-1' });
  });
});

describe('getAccessKeysInScope status', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.useFakeTimers({ now: new Date('2026-06-15T12:00:00Z') });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { expiresAt: undefined, status: 'active' },
    { expiresAt: '2026-06-16', status: 'active' },
    { expiresAt: '2026-06-01', status: 'expired' },
  ])(
    'reports $status for a key expiring on $expiresAt, whatever the stored status says',
    async ({ expiresAt, status }) => {
      // Every stored row says `active`; the listing must not echo it.
      ddbMock.on(QueryCommand).resolves({ Items: [row('1', 'any-user', false, expiresAt)] });

      const [key] = await getAccessKeysInScope('org-1', { sees: 'all' });

      expect(key).toMatchObject({ status, expiresAt: expiresAt ?? null });
    },
  );
});

describe('isAccessKeyExpired', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it.each([
    { expiresAt: null, expired: false, when: 'the key never expires' },
    { expiresAt: '2026-06-16', expired: false, when: 'the expiry date is tomorrow' },
    { expiresAt: '2026-06-15', expired: false, when: 'the expiry date is today (UTC)' },
    { expiresAt: '2026-06-14', expired: true, when: 'the expiry date has passed' },
    // Not a date: only a bad write can store this.
    { expiresAt: 'not-a-date', expired: true, when: 'the stored expiry is unparseable' },
  ])('returns $expired when $when', ({ expiresAt, expired }) => {
    expect(isAccessKeyExpired(expiresAt, now)).toBe(expired);
  });

  it('returns false at the last instant of the expiry date (UTC)', () => {
    expect(isAccessKeyExpired('2026-06-15', new Date('2026-06-15T23:59:59.999Z'))).toBe(false);
  });

  it('returns true from the first instant of the day after the expiry date (UTC)', () => {
    expect(isAccessKeyExpired('2026-06-15', new Date('2026-06-16T00:00:00Z'))).toBe(true);
  });
});

describe('countAccessKeysInScope', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('counts every row under keys.manage_all', async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [row('1', 'user-1'), row('2', 'user-2'), row('3')] });

    expect(await countAccessKeysInScope('org-1', { sees: 'all' })).toBe(3);
  });

  it('counts only the caller-created rows under keys.manage_own', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [row('1', 'user-1'), row('2', 'user-2'), row('3'), row('4', 'user-1', true)],
    });

    expect(await countAccessKeysInScope('org-1', { sees: 'own', userId: 'user-1' })).toBe(1);
  });

  it('answers zero without querying when the caller sees no keys', async () => {
    expect(await countAccessKeysInScope('org-1', { sees: 'none' })).toBe(0);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});
