import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import {
  addRegisteredPrincipals,
  getOrgProfile,
  isOrgDeletedOrDeleting,
  isOrgDeleting,
  orgNotDeletingCheck,
  OrgDeletingError,
  removeRegisteredPrincipal,
  sendDeletionGuardedWrite,
} from './org-profile.ts';

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

    await getOrgProfile('org-1', { consistentRead: true });
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

describe('isOrgDeletedOrDeleting', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('is true while deleting', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: { deleting: { BOOL: true } } });
    await expect(isOrgDeletedOrDeleting('org-1')).resolves.toBe(true);
  });

  // The difference from isOrgDeleting: a scheduled job's candidate list can
  // outlive the rows it was built from, so a missing profile means gone.
  it('is true once the profile row is purged', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    await expect(isOrgDeletedOrDeleting('org-1')).resolves.toBe(true);
    await expect(isOrgDeleting('org-1')).resolves.toBe(false);
  });

  it('is false for a live org', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: { pk: { S: 'ORG#org-1' } } });
    await expect(isOrgDeletedOrDeleting('org-1')).resolves.toBe(false);
  });

  it('always reads consistently', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    await isOrgDeletedOrDeleting('org-1');

    expect(ddbMock.commandCalls(GetItemCommand)[0]!.args[0].input).toMatchObject({
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

describe('registered principals', () => {
  const profileKey = { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } };
  const notDeleting = 'attribute_exists(pk) AND attribute_not_exists(deleting)';

  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(UpdateItemCommand).resolves({});
  });

  // The regression fence. These write the same row the deletion guard checks,
  // and DynamoDB refuses a transaction carrying two operations on one item, so
  // the guard has to ride on the update itself.
  it('adds ids with one conditional update, not a transaction', async () => {
    await addRegisteredPrincipals('org-1', 'forgeDev', ['user-1', 'user-2']);

    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
    const calls = ddbMock.commandCalls(UpdateItemCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toStrictEqual({
      TableName: 'UserInfoTable',
      Key: profileKey,
      ConditionExpression: notDeleting,
      UpdateExpression: 'ADD #principals :ids',
      ExpressionAttributeNames: { '#principals': 'forgeDevPrincipals' },
      ExpressionAttributeValues: { ':ids': { SS: ['user-1', 'user-2'] } },
    });
  });

  it('de-duplicates ids and writes nothing for an empty list', async () => {
    await addRegisteredPrincipals('org-1', 'forgeDev', ['user-1', 'user-1']);
    expect(
      ddbMock.commandCalls(UpdateItemCommand)[0]!.args[0].input.ExpressionAttributeValues,
    ).toStrictEqual({ ':ids': { SS: ['user-1'] } });

    ddbMock.reset();
    ddbMock.on(UpdateItemCommand).resolves({});
    await addRegisteredPrincipals('org-1', 'forgeDev', []);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('removes one id with one conditional update', async () => {
    await removeRegisteredPrincipal('org-1', 'forgeDev', 'user-1');

    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
    const calls = ddbMock.commandCalls(UpdateItemCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toStrictEqual({
      TableName: 'UserInfoTable',
      Key: profileKey,
      ConditionExpression: notDeleting,
      UpdateExpression: 'DELETE #principals :ids',
      ExpressionAttributeNames: { '#principals': 'forgeDevPrincipals' },
      ExpressionAttributeValues: { ':ids': { SS: ['user-1'] } },
    });
  });

  it('reports a refused condition as the org being deleted', async () => {
    ddbMock
      .on(UpdateItemCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'refused', $metadata: {} }));

    await expect(addRegisteredPrincipals('org-1', 'forgeDev', ['user-1'])).rejects.toBeInstanceOf(
      OrgDeletingError,
    );
    await expect(removeRegisteredPrincipal('org-1', 'forgeDev', 'user-1')).rejects.toBeInstanceOf(
      OrgDeletingError,
    );
  });

  it('rethrows unrelated failures', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('throttled'));

    await expect(addRegisteredPrincipals('org-1', 'forgeDev', ['user-1'])).rejects.toThrow(
      'throttled',
    );
  });
});
