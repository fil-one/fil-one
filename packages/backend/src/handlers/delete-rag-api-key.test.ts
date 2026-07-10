import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './delete-rag-api-key.js';
import { RagApiKeyKeys } from '../lib/rag-api-keys.js';
import { buildEvent } from '../test/lambda-test-utilities.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';

const USER_INFO = { userId: 'user-1', orgId: 'org-1', emailVerified: true };
const TOKEN_HASH = 'b'.repeat(64);

function deleteEvent(keyId?: string): AuthenticatedEvent {
  const event = buildEvent({ userInfo: USER_INFO, method: 'DELETE' });
  if (keyId) event.pathParameters = { keyId };
  return event;
}

describe('delete-rag-api-key baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns 400 when keyId is missing from the path', async () => {
    const result = await baseHandler(deleteEvent());
    expect(result).toMatchObject({ statusCode: 400 });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('deletes both rows transactionally, scoping the lookup delete to the caller org', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: marshall({ pk: 'ORG#org-1', sk: 'RAGKEY#key-1', tokenHash: TOKEN_HASH }),
    });
    ddbMock.on(TransactWriteItemsCommand).resolves({});

    const result = await baseHandler(deleteEvent('key-1'));

    expect(result).toMatchObject({ statusCode: 204 });

    // Ownership proof: the record is read under the caller's own org partition.
    const get = ddbMock.commandCalls(GetItemCommand)[0].args[0].input;
    expect(get.Key).toEqual(marshall({ pk: 'ORG#org-1', sk: 'RAGKEY#key-1' }));

    const items =
      ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0].Delete!.Key).toEqual(marshall({ pk: 'ORG#org-1', sk: 'RAGKEY#key-1' }));
    expect(items[1].Delete!.Key).toEqual(
      marshall({ pk: RagApiKeyKeys.lookupPk(TOKEN_HASH), sk: RagApiKeyKeys.lookupSk() }),
    );
    expect(items[1].Delete!.ConditionExpression).toBe('orgId = :orgId');
    expect(items[1].Delete!.ExpressionAttributeValues).toEqual({ ':orgId': { S: 'org-1' } });
  });

  it('returns 404 for a keyId the org does not own (partition miss)', async () => {
    ddbMock.on(GetItemCommand).resolves({});

    const result = await baseHandler(deleteEvent('foreign-key'));

    expect(result).toMatchObject({ statusCode: 404 });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('returns 404 when a concurrent delete cancels the transaction', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: marshall({ pk: 'ORG#org-1', sk: 'RAGKEY#key-1', tokenHash: TOKEN_HASH }),
    });
    const cancel = new Error('cancelled');
    cancel.name = 'TransactionCanceledException';
    ddbMock.on(TransactWriteItemsCommand).rejects(cancel);

    const result = await baseHandler(deleteEvent('key-1'));

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('rethrows unexpected transaction errors', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: marshall({ pk: 'ORG#org-1', sk: 'RAGKEY#key-1', tokenHash: TOKEN_HASH }),
    });
    ddbMock.on(TransactWriteItemsCommand).rejects(new Error('boom'));

    await expect(baseHandler(deleteEvent('key-1'))).rejects.toThrow('boom');
  });
});
