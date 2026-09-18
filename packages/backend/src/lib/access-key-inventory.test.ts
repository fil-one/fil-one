import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({
  Resource: { UserInfoTable: { name: 'UserInfoTable' } },
}));

const ddbMock = mockClient(DynamoDBClient);
process.env.FILONE_STAGE = 'test';

import { countAccessKeysInScope, getAccessKeysInScope } from './access-key-inventory.ts';

function row(id: string, createdBy?: string, recovered?: boolean) {
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

  it('narrows to the keys whose network serves the region, in code', async () => {
    // A key works at every region of its network, so the filter reads the
    // network off each row (or the region a legacy row names) rather than
    // asking DynamoDB for a stored region.
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { ...row('fth-network'), orchestratorId: { S: 'fth' } },
        { ...row('fth-legacy'), region: { S: 'us-east-1' } },
        row('aurora-legacy'),
        { ...row('forge-network'), orchestratorId: { S: 'forge' } },
      ],
    });

    const keys = await getAccessKeysInScope(
      'org-1',
      { sees: 'all' },
      { regionFilter: 'us-east-1' },
    );

    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.FilterExpression).toBeUndefined();
    expect(keys.map((k) => k.id)).toStrictEqual(['fth-network', 'fth-legacy']);
    expect(keys.every((k) => k.regions.includes('us-east-1'))).toBe(true);
  });

  it('reports every region of the network holding a key', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [row('aurora-legacy'), { ...row('fth-network'), orchestratorId: { S: 'fth' } }],
    });

    const keys = await getAccessKeysInScope('org-1', { sees: 'all' });

    expect(keys.map((k) => k.regions)).toStrictEqual([['eu-west-1'], ['us-east-1']]);
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
