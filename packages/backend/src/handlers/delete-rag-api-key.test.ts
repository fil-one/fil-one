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

// Full-chain gate tests exercise the REAL ragAccessMiddleware (allowlist check);
// auth/csrf/subscription are stubbed to pass-through so the gate is tested in isolation.
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: () => ({ before: () => undefined }),
}));
vi.mock('../middleware/csrf.js', () => ({
  csrfMiddleware: () => ({ before: () => undefined }),
}));
vi.mock('../middleware/subscription-guard.js', () => ({
  AccessLevel: { Read: 'read', Write: 'write' },
  subscriptionGuardMiddleware: () => ({ before: () => undefined }),
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler, handler } from './delete-rag-api-key.js';
import { RagApiKeyKeys } from '../lib/rag-api-keys.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';
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

describe('delete-rag-api-key handler (allowlist gate)', () => {
  const EMAIL = 'outsider@example.com';
  const nonFoundationEvent = () => {
    const event = buildEvent({
      userInfo: { userId: 'user-1', orgId: 'org-1', email: EMAIL, emailVerified: true },
      method: 'DELETE',
    });
    event.pathParameters = { keyId: 'key-1' };
    return event as AuthenticatedEvent;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ddbMock.on(TransactWriteItemsCommand).resolves({});
    // The key the handler would delete once the gate passes.
    ddbMock
      .on(GetItemCommand, {
        Key: marshall({ pk: 'ORG#org-1', sk: 'RAGKEY#key-1' }),
      })
      .resolves({ Item: marshall({ pk: 'ORG#org-1', sk: 'RAGKEY#key-1', tokenHash: TOKEN_HASH }) });
  });

  it('returns 403 when the caller is not foundation and not allowlisted', async () => {
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ALLOWLIST#${EMAIL}` }, sk: { S: 'RAG' } } })
      .resolves({
        Item: undefined,
      });

    const result = await handler(nonFoundationEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 403 });
    // Nothing is deleted when the gate denies.
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('allows an allowlisted caller to delete a key', async () => {
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: `ALLOWLIST#${EMAIL}` }, sk: { S: 'RAG' } } })
      .resolves({
        Item: marshall({ pk: `ALLOWLIST#${EMAIL}`, sk: 'RAG' }),
      });

    const result = await handler(nonFoundationEvent(), buildContext());

    expect(result).toMatchObject({ statusCode: 204 });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
  });
});
