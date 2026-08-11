import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
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
  OrgDeletingError,
  orgNotDeletingCheck,
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

describe('orgNotDeletingCheck', () => {
  it('requires the PROFILE row to exist, so a purged org is refused', () => {
    // attribute_not_exists(deleting) alone is TRUE against a MISSING item, so
    // without attribute_exists(pk) every fenced writer could resurrect an org
    // whose PROFILE row the teardown already purged — the exact class the fence
    // exists to close. No live org can lack the row: it is created in the same
    // transaction as the SUB#/IDENTITY row that is the only path to the orgId.
    const check = orgNotDeletingCheck('org-1').ConditionCheck!;

    expect(check.TableName).toBe('UserInfoTable');
    expect(check.Key).toEqual({ pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } });
    expect(check.ConditionExpression).toBe(
      'attribute_exists(pk) AND (attribute_not_exists(deleting) OR deleting = :notDeleting)',
    );
    expect(check.ExpressionAttributeValues).toEqual({ ':notDeleting': { BOOL: false } });
  });

  it('accepts a literal `deleting: false`, agreeing with isOrgDeleting', () => {
    // isOrgDeleting tests `=== true`, so a literal false reads as healthy. If
    // the fence disagreed, create-access-key would pass its pre-check, mint the
    // credential upstream, then have its fenced write rejected — and compensate
    // by revoking a HEALTHY org's key.
    expect(isOrgDeleting({ deleting: { BOOL: false } })).toBe(false);
    expect(orgNotDeletingCheck('org-1').ConditionCheck!.ConditionExpression).toContain(
      'OR deleting = :notDeleting',
    );
  });
});

describe('sendDeletionGuardedWrite', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  /** A TransactionCanceledException whose per-item reason codes are `codes`. */
  function cancelled(codes: (string | undefined)[]) {
    return new TransactionCanceledException({
      message: 'cancelled',
      $metadata: {},
      CancellationReasons: codes.map((Code) => ({ Code })),
    });
  }

  const write = { Put: { TableName: 'UserInfoTable', Item: { pk: { S: 'ORG#org-1' } } } };

  it('sends the fence as item 0, ahead of the caller writes', async () => {
    ddbMock.on(TransactWriteItemsCommand).resolves({});

    await sendDeletionGuardedWrite('org-1', [write]);

    const items = ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems!;
    expect(items).toHaveLength(2);
    expect(items[0].ConditionCheck?.Key).toEqual({
      pk: { S: 'ORG#org-1' },
      sk: { S: 'PROFILE' },
    });
    expect(items[1]).toBe(write);
  });

  it('maps a cancellation on item 0 to OrgDeletingError', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelled(['ConditionalCheckFailed', 'None']));

    await expect(sendDeletionGuardedWrite('org-1', [write])).rejects.toBeInstanceOf(
      OrgDeletingError,
    );
  });

  it("re-throws a caller's OWN failed condition untouched — item 0 is not the fence there", async () => {
    // Attributability is the whole point of pinning the check to slot 0: a
    // create-only write losing its attribute_not_exists(pk) race is a 409, not
    // a deleted account.
    const err = cancelled(['None', 'ConditionalCheckFailed']);
    ddbMock.on(TransactWriteItemsCommand).rejects(err);

    await expect(sendDeletionGuardedWrite('org-1', [write])).rejects.toBe(err);
  });

  it('re-throws a non-TransactionCanceledException untouched', async () => {
    const err = new Error('throttled');
    ddbMock.on(TransactWriteItemsCommand).rejects(err);

    await expect(sendDeletionGuardedWrite('org-1', [write])).rejects.toBe(err);
  });

  it('re-throws a cancellation with no CancellationReasons untouched', async () => {
    // The SDK omits the field when it cannot attribute the cancellation;
    // guessing "the fence rejected" there would report a live org as deleted.
    const err = new TransactionCanceledException({ message: 'cancelled', $metadata: {} });
    ddbMock.on(TransactWriteItemsCommand).rejects(err);

    await expect(sendDeletionGuardedWrite('org-1', [write])).rejects.toBe(err);
  });

  it('retries a TransactionConflict and succeeds', async () => {
    // New failure class introduced BY the fence: the ConditionCheck makes every
    // fenced write contend on ORG#/PROFILE, which tenant setup, update-profile
    // and the deletion guards all write. Creating an access key while a bucket
    // creation drives tenant setup must not 500.
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejectsOnce(cancelled(['TransactionConflict', 'None']))
      .resolves({});

    await expect(
      sendDeletionGuardedWrite('org-1', [write], { retries: 2, minTimeout: 0 }),
    ).resolves.toBe(undefined);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(2);
  });

  it('gives up on a persistent TransactionConflict with the original error', async () => {
    const err = cancelled(['TransactionConflict', 'None']);
    ddbMock.on(TransactWriteItemsCommand).rejects(err);

    await expect(
      sendDeletionGuardedWrite('org-1', [write], { retries: 1, minTimeout: 0 }),
    ).rejects.toBe(err);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(2);
  });

  it('never retries a fence rejection — the org is not going to stop deleting', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(cancelled(['ConditionalCheckFailed', 'None']));

    await expect(
      sendDeletionGuardedWrite('org-1', [write], { retries: 3, minTimeout: 0 }),
    ).rejects.toBeInstanceOf(OrgDeletingError);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
  });
});
