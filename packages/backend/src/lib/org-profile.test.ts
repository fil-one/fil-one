import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { getOrgProfile } from './org-profile.js';

describe('getOrgProfile', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('fetches the ORG#{orgId}/PROFILE row from UserInfoTable', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: {} });

    await getOrgProfile('org-1');

    expect(ddbMock.commandCalls(GetItemCommand)[0]?.args[0].input).toEqual({
      TableName: 'UserInfoTable',
      Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
    });
  });

  it('returns the PROFILE item', async () => {
    const item = { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' }, fthTenantId: { S: 'fth-t-1' } };
    ddbMock.on(GetItemCommand).resolves({ Item: item });

    const result = await getOrgProfile('org-1');

    expect(result).toEqual(item);
  });

  // The `deleting` fence (FIL-112) is mutable, so every caller that acts on it
  // — the tenant-setup paths — must read it strongly consistently.
  it('issues a strongly-consistent read when { consistent: true }', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: {} });

    await getOrgProfile('org-1', { consistent: true });

    expect(ddbMock.commandCalls(GetItemCommand)[0]?.args[0].input).toEqual({
      TableName: 'UserInfoTable',
      Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
      ConsistentRead: true,
    });
  });

  it('omits ConsistentRead entirely when { consistent: false }', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: {} });

    await getOrgProfile('org-1', { consistent: false });

    expect(ddbMock.commandCalls(GetItemCommand)[0]?.args[0].input).not.toHaveProperty(
      'ConsistentRead',
    );
  });

  it('returns undefined when no PROFILE row exists', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    const result = await getOrgProfile('org-1');

    expect(result).toBeUndefined();
  });
});
