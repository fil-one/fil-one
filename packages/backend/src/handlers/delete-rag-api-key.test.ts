import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authPartialMock } from '../test/auth-partial-mock.js';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

import { sstResourceMock } from '../test/sst-resource-mock.js';

vi.mock('sst', () => sstResourceMock());

// The role-enforcement block at the bottom runs the route's real chain. Auth is
// stubbed so the caller arrives on the event; csrf and the subscription guard
// are stubbed because each has its own suite.
vi.mock('../middleware/auth.js', () => authPartialMock());
vi.mock('../middleware/csrf.js', () => ({
  csrfMiddleware: () => ({ before: () => undefined }),
}));
vi.mock('../middleware/subscription-guard.js', () => ({
  AccessLevel: { Read: 'read', Write: 'write' },
  subscriptionGuardMiddleware: () => ({ before: () => undefined }),
}));

const ddbMock = mockClient(DynamoDBClient);

import { ApiErrorCode, OrgRole } from '@filone/shared';
import { baseHandler } from './delete-rag-api-key.js';
import { RagApiKeyKeys } from '../lib/rag-api-keys.js';
import { buildEvent, membershipFor } from '../test/lambda-test-utilities.js';
import type { AuthenticatedEvent } from '../lib/user-context.js';

const USER_INFO = { userId: 'user-1', orgId: 'org-1', emailVerified: true };
const TOKEN_HASH = 'b'.repeat(64);

function deleteEvent(keyId?: string, role?: OrgRole): AuthenticatedEvent {
  const event = buildEvent({
    userInfo: {
      ...USER_INFO,
      ...(role ? { membership: membershipFor(USER_INFO.orgId, USER_INFO.userId, role) } : {}),
    },
    method: 'DELETE',
  });
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
    expect(items).toHaveLength(3);
    expect(items[0].Delete!.Key).toEqual(marshall({ pk: 'ORG#org-1', sk: 'RAGKEY#key-1' }));
    expect(items[1].Delete!.Key).toEqual(
      marshall({ pk: RagApiKeyKeys.lookupPk(TOKEN_HASH), sk: RagApiKeyKeys.lookupSk() }),
    );
    expect(items[1].Delete!.ConditionExpression).toBe('orgId = :orgId');
    expect(items[1].Delete!.ExpressionAttributeValues).toEqual({ ':orgId': { S: 'org-1' } });
  });

  it('records the revocation in the same transaction as the deletes', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: marshall({
        pk: 'ORG#org-1',
        sk: 'RAGKEY#key-1',
        tokenHash: TOKEN_HASH,
        keyName: 'ci key',
      }),
    });
    ddbMock.on(TransactWriteItemsCommand).resolves({});

    await baseHandler(deleteEvent('key-1'));

    const items =
      ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems ?? [];
    expect(items[2].Put!.TableName).toBe('AuditTable');
    expect(items[2].Put!.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(unmarshall(items[2].Put!.Item!)).toMatchObject({
      pk: 'ORG#org-1',
      type: 'key.revoked',
      orgId: 'org-1',
      subject: 'key:key-1',
      actor: { kind: 'user', id: 'user-1' },
      details: { keyKind: 'rag', keyName: 'ci key' },
    });
    // The token hash is the credential's lookup key and never reaches the log.
    expect(JSON.stringify(items[2])).not.toContain(TOKEN_HASH);
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

describe('whose RAG key a caller may revoke', () => {
  function storedKey(createdBy?: string) {
    return marshall({
      pk: 'ORG#org-1',
      sk: 'RAGKEY#key-1',
      tokenHash: TOKEN_HASH,
      ...(createdBy ? { createdBy } : {}),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ddbMock.on(TransactWriteItemsCommand).resolves({});
  });

  it('lets a Member revoke a key they created', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: storedKey('user-1') });

    expect(await baseHandler(deleteEvent('key-1', OrgRole.Member))).toMatchObject({
      statusCode: 204,
    });
  });

  it("refuses a Member someone else's key", async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: storedKey('user-2') });

    const result = (await baseHandler(deleteEvent('key-1', OrgRole.Member))) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).code).toBe(ApiErrorCode.FORBIDDEN_ROLE);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('refuses a Member an unattributed key, which nobody can claim', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: storedKey() });

    expect(await baseHandler(deleteEvent('key-1', OrgRole.Member))).toMatchObject({
      statusCode: 403,
    });
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it.each([OrgRole.Owner, OrgRole.Admin])('lets %s revoke any key in the org', async (role) => {
    ddbMock.on(GetItemCommand).resolves({ Item: storedKey('user-2') });

    expect(await baseHandler(deleteEvent('key-1', role))).toMatchObject({ statusCode: 204 });
  });
});
