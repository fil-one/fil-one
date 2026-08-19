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

  it('spends the code, records the deletion and raises the fence atomically', async () => {
    const result = await confirmAccountDeletion(PARAMS);

    expect(result).toEqual({ outcome: 'confirmed' });
    const items = sentItems();
    // One fence row rather than one per member, so the size never depends on the org.
    expect(items).toHaveLength(3);
    expect(items[0]!.Delete?.TableName).toBe('DeletionChallengeTable');
    expect(items[1]!.Put?.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(items[2]!.Update?.Key).toEqual(marshall({ pk: 'ORG#org-1', sk: 'PROFILE' }));
  });

  it('never writes the plaintext code', async () => {
    await confirmAccountDeletion(PARAMS);

    expect(JSON.stringify(sentItems())).not.toContain(PARAMS.code);
  });

  // The receipt names its trigger, so it tells a user's own request apart from an
  // admin deleting the org's Stripe customer.
  it('writes the receipt, naming the user who asked', async () => {
    await confirmAccountDeletion(PARAMS);

    expect(unmarshall(sentItems()[1]!.Put!.Item!)).toMatchObject({
      pk: 'ORG#org-1',
      sk: 'DELETION',
      status: 'PENDING',
      trigger: 'USER_REQUEST',
      requestedByUserId: 'user-1',
      attempts: 0,
    });
  });

  it('will not raise the fence on a profile that is not there', async () => {
    await confirmAccountDeletion(PARAMS);

    expect(sentItems()[2]!.Update?.ConditionExpression).toBe('attribute_exists(pk)');
  });

  it('treats a double confirm as already deleting rather than a second teardown', async () => {
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejects(cancelled([OK, { Code: 'ConditionalCheckFailed' }, OK]));

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
