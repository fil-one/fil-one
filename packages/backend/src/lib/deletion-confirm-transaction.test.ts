import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type CancellationReason,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
    DeletionChallengeTable: { name: 'DeletionChallengeTable' },
    DeletionCodeHmacKey: { value: 'test-hmac-key' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { confirmAccountDeletion, consumeVerifyAttempt } from './deletion-confirm-transaction.js';
import { MAX_VERIFY_ATTEMPTS } from './deletion-challenge.js';

const PARAMS = {
  orgId: 'org-1',
  requestedByUserId: 'user-1',
  code: '123456',
  salt: 'deadbeef',
  members: [
    { userId: 'user-1', sub: 'auth0|one', stripeCustomerId: 'cus_1' },
    { userId: 'user-2', sub: 'auth0|two' },
  ],
  tenantIds: { aurora: 'aurora-t-1', fth: '42' },
};

function cancelled(reasons: CancellationReason[]) {
  return new TransactionCanceledException({
    message: 'cancelled',
    $metadata: {},
    CancellationReasons: reasons,
  });
}

const OK: CancellationReason = { Code: 'None' };

function sentItems() {
  return ddbMock.commandCalls(TransactWriteItemsCommand)[0]!.args[0].input.TransactItems!;
}

describe('confirmAccountDeletion', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(TransactWriteItemsCommand).resolves({});
  });

  it('spends the code, records the deletion and fences every member atomically', async () => {
    const result = await confirmAccountDeletion(PARAMS);

    expect(result).toEqual({ outcome: 'confirmed' });
    const items = sentItems();
    // 3 fixed items + one tombstone per member.
    expect(items).toHaveLength(5);
    expect(items[0]!.Delete?.TableName).toBe('DeletionChallengeTable');
    expect(items[1]!.Put?.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(items[2]!.Update?.Key).toEqual(marshall({ pk: 'ORG#org-1', sk: 'PROFILE' }));
    expect(items[3]!.Update?.Key).toEqual(marshall({ pk: 'SUB#auth0|one', sk: 'IDENTITY' }));
    expect(items[4]!.Update?.Key).toEqual(marshall({ pk: 'SUB#auth0|two', sk: 'IDENTITY' }));
  });

  it('never writes the plaintext code', async () => {
    await confirmAccountDeletion(PARAMS);

    expect(JSON.stringify(sentItems())).not.toContain(PARAMS.code);
  });

  it('snapshots members and tenant ids onto the record', async () => {
    await confirmAccountDeletion(PARAMS);

    const record = unmarshall(sentItems()[1]!.Put!.Item!);
    expect(record).toMatchObject({
      pk: 'ORG#org-1',
      sk: 'DELETION',
      status: 'PENDING',
      requestedByUserId: 'user-1',
      members: PARAMS.members,
      tenantIds: PARAMS.tenantIds,
      attempts: 0,
    });
  });

  // Only the tombstones are unconditional: a member whose identity row vanished
  // must still be fenced.
  it('fences the org conditionally but the identities unconditionally', async () => {
    await confirmAccountDeletion(PARAMS);

    const items = sentItems();
    expect(items[2]!.Update?.ConditionExpression).toBe('attribute_exists(pk)');
    expect(items[3]!.Update?.ConditionExpression).toBeUndefined();
  });

  it('treats a double confirm as already deleting rather than a second teardown', async () => {
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejects(cancelled([OK, { Code: 'ConditionalCheckFailed' }, OK, OK, OK]));

    await expect(confirmAccountDeletion(PARAMS)).resolves.toEqual({
      outcome: 'already_deleting',
    });
  });

  it('reads a wrong code off the rejected challenge row', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(
      cancelled([
        {
          Code: 'ConditionalCheckFailed',
          Item: marshall({ attempts: 1, expiresAt: '2999-01-01T00:00:00.000Z' }),
        },
        OK,
      ]),
    );

    await expect(confirmAccountDeletion(PARAMS)).resolves.toEqual({ outcome: 'code_invalid' });
  });

  it.each([
    [
      'the attempt budget is spent',
      { attempts: MAX_VERIFY_ATTEMPTS, expiresAt: '2999-01-01T00:00:00.000Z' },
    ],
    ['the code has expired', { attempts: 0, expiresAt: '2000-01-01T00:00:00.000Z' }],
  ])('reports expired_or_locked when %s', async (_label, row) => {
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejects(cancelled([{ Code: 'ConditionalCheckFailed', Item: marshall(row) }, OK]));

    await expect(confirmAccountDeletion(PARAMS)).resolves.toEqual({
      outcome: 'code_expired_or_locked',
    });
  });

  it('reports expired_or_locked when the row is gone entirely', async () => {
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejects(cancelled([{ Code: 'ConditionalCheckFailed' }, OK]));

    await expect(confirmAccountDeletion(PARAMS)).resolves.toEqual({
      outcome: 'code_expired_or_locked',
    });
  });

  it('retries a transaction conflict', async () => {
    vi.useFakeTimers();
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejectsOnce(cancelled([{ Code: 'TransactionConflict' }, OK]))
      .resolves({});

    const promise = confirmAccountDeletion(PARAMS);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ outcome: 'confirmed' });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(2);
    vi.useRealTimers();
  });

  it('rethrows a cancellation it cannot attribute', async () => {
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejects(cancelled([OK, OK, { Code: 'ConditionalCheckFailed' }]));

    await expect(confirmAccountDeletion(PARAMS)).rejects.toBeInstanceOf(
      TransactionCanceledException,
    );
  });
});

describe('consumeVerifyAttempt', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('increments only while the budget lasts', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await consumeVerifyAttempt('org-1');

    expect(ddbMock.commandCalls(UpdateItemCommand)[0]!.args[0].input).toMatchObject({
      UpdateExpression: 'ADD attempts :one',
      ConditionExpression: 'attribute_exists(pk) AND attempts < :maxAttempts',
    });
  });

  it('is a no-op once locked or already gone', async () => {
    ddbMock
      .on(UpdateItemCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'failed', $metadata: {} }));

    await expect(consumeVerifyAttempt('org-1')).resolves.toBeUndefined();
  });

  it('rethrows anything else', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('throttled'));

    await expect(consumeVerifyAttempt('org-1')).rejects.toThrow('throttled');
  });
});
