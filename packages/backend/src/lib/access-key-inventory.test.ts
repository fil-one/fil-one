import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({
  Resource: { UserInfoTable: { name: 'UserInfoTable' } },
}));

const ddbMock = mockClient(DynamoDBClient);

import { countAccessKeysInScope } from './access-key-inventory.js';

function row(createdBy?: string, recovered?: boolean) {
  return {
    ...(createdBy ? { createdBy: { S: createdBy } } : {}),
    ...(recovered ? { recovered: { BOOL: true } } : {}),
  };
}

describe('countAccessKeysInScope', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('counts every row under keys.manage_all', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row('user-1'), row('user-2'), row()] });

    expect(await countAccessKeysInScope('org-1', { sees: 'all' })).toBe(3);
  });

  it('counts only the caller-created rows under keys.manage_own', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [row('user-1'), row('user-2'), row(), row('user-1', true)],
    });

    expect(await countAccessKeysInScope('org-1', { sees: 'own', userId: 'user-1' })).toBe(1);
  });

  it('answers zero without querying when the caller sees no keys', async () => {
    expect(await countAccessKeysInScope('org-1', { sees: 'none' })).toBe(0);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  // A truncated page would silently undercount, which is the bug this exists to fix.
  it('follows every page of results', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [row('user-1'), row('user-2')], LastEvaluatedKey: { sk: { S: 'a' } } })
      .resolvesOnce({ Items: [row('user-3')] });

    expect(await countAccessKeysInScope('org-1', { sees: 'all' })).toBe(3);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
  });
});
