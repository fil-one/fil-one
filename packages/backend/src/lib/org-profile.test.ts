import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import {
  getOrgProfile,
  isOrgDeleting,
  orgNotDeletingCheck,
  OrgDeletingError,
  sendDeletionGuardedWrite,
} from './org-profile.js';

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

  it('returns undefined when no PROFILE row exists', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    const result = await getOrgProfile('org-1');

    expect(result).toBeUndefined();
  });

  it('reads consistently only when asked', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: {} });

    await getOrgProfile('org-1', { consistent: true });
    expect(ddbMock.commandCalls(GetItemCommand)[0]?.args[0].input).toMatchObject({
      ConsistentRead: true,
    });

    await getOrgProfile('org-1');
    expect(ddbMock.commandCalls(GetItemCommand)[1]?.args[0].input.ConsistentRead).toBeUndefined();
  });
});

describe('isOrgDeleting', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('is true only for an explicit BOOL true', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: { deleting: { BOOL: true } } });
    await expect(isOrgDeleting('org-1')).resolves.toBe(true);

    ddbMock.on(GetItemCommand).resolves({ Item: { deleting: { BOOL: false } } });
    await expect(isOrgDeleting('org-1')).resolves.toBe(false);
  });

  it('fails open on an absent attribute or a missing row', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: { pk: { S: 'ORG#org-1' } } });
    await expect(isOrgDeleting('org-1')).resolves.toBe(false);

    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    await expect(isOrgDeleting('org-1')).resolves.toBe(false);
  });

  it('reads eventually consistently unless asked otherwise', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    await isOrgDeleting('org-1');
    expect(ddbMock.commandCalls(GetItemCommand)[0]!.args[0].input.ConsistentRead).toBeUndefined();

    await isOrgDeleting('org-1', { consistent: true });
    expect(ddbMock.commandCalls(GetItemCommand)[1]!.args[0].input).toMatchObject({
      ConsistentRead: true,
    });
  });
});

describe('orgNotDeletingCheck', () => {
  it('conditions on the profile row existing and carrying no deleting flag', () => {
    expect(orgNotDeletingCheck('org-1')).toEqual({
      ConditionCheck: {
        TableName: 'UserInfoTable',
        Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleting)',
      },
    });
  });
});

describe('sendDeletionGuardedWrite', () => {
  const callerItem: TransactWriteItem = {
    Put: { TableName: 'UserInfoTable', Item: { pk: { S: 'ORG#org-1' }, sk: { S: 'RAGKEY#1' } } },
  };

  function cancelledWith(codes: string[]) {
    return new TransactionCanceledException({
      message: 'cancelled',
      $metadata: {},
      CancellationReasons: codes.map((Code) => ({ Code })),
    });
  }

  beforeEach(() => {
    ddbMock.reset();
  });

  it('prepends the guard as item 0', async () => {
    ddbMock.on(TransactWriteItemsCommand).resolves({});

    await sendDeletionGuardedWrite('org-1', [callerItem]);

    const { TransactItems } = ddbMock.commandCalls(TransactWriteItemsCommand)[0]!.args[0].input;
    expect(TransactItems).toEqual([orgNotDeletingCheck('org-1'), callerItem]);
  });

  it('maps a guard rejection to OrgDeletingError', async () => {
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejects(cancelledWith(['ConditionalCheckFailed', 'None']));

    await expect(sendDeletionGuardedWrite('org-1', [callerItem])).rejects.toBeInstanceOf(
      OrgDeletingError,
    );
  });

  it("rethrows when it is the caller's own condition that failed", async () => {
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejects(cancelledWith(['None', 'ConditionalCheckFailed']));

    await expect(sendDeletionGuardedWrite('org-1', [callerItem])).rejects.not.toBeInstanceOf(
      OrgDeletingError,
    );
  });

  it('rethrows unrelated failures', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(new Error('throttled'));

    await expect(sendDeletionGuardedWrite('org-1', [callerItem])).rejects.toThrow('throttled');
  });
});
