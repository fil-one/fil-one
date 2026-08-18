import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authPartialMock } from '../test/auth-partial-mock.js';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

import { sstResourceMock } from '../test/sst-resource-mock.js';
import { auditItemIn, expectNoSecrets, hasAuditItem } from '../test/audit-assertions.js';

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
/** The twelve characters the console lists a RAG key by. */
const KEY_PREFIX = 'sk_rag_AbC12';

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
        keyPrefix: KEY_PREFIX,
      }),
    });
    ddbMock.on(TransactWriteItemsCommand).resolves({});

    await baseHandler(deleteEvent('key-1'));

    const items =
      ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems ?? [];
    const auditItem = auditItemIn(items);
    expect(unmarshall(auditItem)).toMatchObject({
      pk: 'ORG#org-1',
      type: 'key.deleted',
      orgId: 'org-1',
      // Both halves name the key the way the console lists it, so an event and
      // a key on screen match. The internal id is a UUID nothing shows.
      subject: `key:${KEY_PREFIX}`,
      actor: { kind: 'user', id: 'user-1' },
      details: { keyKind: 'rag', keyName: 'ci key', keyIdSuffix: KEY_PREFIX },
    });
    // The token hash is the credential's lookup key and never reaches the log.
    expect(JSON.stringify(auditItem)).not.toContain(TOKEN_HASH);
    expectNoSecrets(auditItem);
  });

  it('names a row written before the prefix was stored by its key id', async () => {
    // Otherwise a legacy revocation has no subject at all, and the viewer
    // cannot group it with anything.
    ddbMock.on(GetItemCommand).resolves({
      Item: marshall({ pk: 'ORG#org-1', sk: 'RAGKEY#key-1', tokenHash: TOKEN_HASH }),
    });
    ddbMock.on(TransactWriteItemsCommand).resolves({});

    await baseHandler(deleteEvent('key-1'));

    const items =
      ddbMock.commandCalls(TransactWriteItemsCommand)[0].args[0].input.TransactItems ?? [];
    const event = unmarshall(auditItemIn(items));
    expect(event.subject).toBe('key:key-1');
    expect(event.details).not.toHaveProperty('keyIdSuffix');
  });

  it('deletes the key when the event item is the half the table refused', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: marshall({ pk: 'ORG#org-1', sk: 'RAGKEY#key-1', tokenHash: TOKEN_HASH }),
    });
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejectsOnce(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'None' },
            { Code: 'TransactionConflict' },
          ],
        }),
      )
      .resolves({});

    // Revocation is best-effort on the audit half: a refused event must never
    // become a 404 that reports a live key as revoked.
    const result = await baseHandler(deleteEvent('key-1'));

    expect(result).toMatchObject({ statusCode: 204 });
    const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
    expect(calls).toHaveLength(2);
    expect(hasAuditItem(calls[1].args[0].input.TransactItems)).toBe(false);
    expect(calls[1].args[0].input.TransactItems).toHaveLength(2);
  });

  it.each([
    ['the audit table is missing', 'ResourceNotFoundException', 'Requested resource not found'],
    ['the role may not write it', 'AccessDeniedException', 'User is not authorized'],
  ])('revokes the key when %s', async (_label, name, message) => {
    ddbMock.on(GetItemCommand).resolves({
      Item: marshall({ pk: 'ORG#org-1', sk: 'RAGKEY#key-1', tokenHash: TOKEN_HASH }),
    });
    // Not a cancellation: the whole transaction is refused before any item
    // applies. Rethrowing it would leave a leaked key live and answer 500.
    ddbMock
      .on(TransactWriteItemsCommand)
      .rejectsOnce(Object.assign(new Error(message), { name }))
      .resolves({});

    const result = await baseHandler(deleteEvent('key-1'));

    expect(result).toMatchObject({ statusCode: 204 });
    const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
    expect(calls).toHaveLength(2);
    // Both key rows land; only the event is dropped.
    const retried = calls[1].args[0].input.TransactItems ?? [];
    expect(hasAuditItem(retried)).toBe(false);
    expect(retried).toHaveLength(2);
    expect(retried[0].Delete!.Key).toEqual(marshall({ pk: 'ORG#org-1', sk: 'RAGKEY#key-1' }));
    expect(retried[1].Delete!.Key).toEqual(
      marshall({ pk: RagApiKeyKeys.lookupPk(TOKEN_HASH), sk: RagApiKeyKeys.lookupSk() }),
    );
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
    ddbMock.on(TransactWriteItemsCommand).rejects(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        // The key's own row is the item that failed its condition.
        CancellationReasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'None' },
        ],
      }),
    );

    const result = await baseHandler(deleteEvent('key-1'));

    expect(result).toMatchObject({ statusCode: 404 });
  });

  it.each([
    ['the key row', ['TransactionConflict', 'None']],
    ['the lookup row', ['None', 'TransactionConflict']],
    // A condition that failed alongside a transient says nothing about the key:
    // the transaction cancelled whole, so the lookup delete never ran.
    ['both rows at once', ['ConditionalCheckFailed', 'TransactionConflict']],
  ])(
    'fails rather than reporting the key gone when a conflict cancels %s',
    async (_label, codes) => {
      ddbMock.on(GetItemCommand).resolves({
        Item: marshall({ pk: 'ORG#org-1', sk: 'RAGKEY#key-1', tokenHash: TOKEN_HASH }),
      });
      ddbMock.on(TransactWriteItemsCommand).rejects(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [...codes.map((Code) => ({ Code })), { Code: 'None' }],
        }),
      );

      // Nothing was deleted and the LOOKUP row still authorises the key, so 404
      // would tell the caller a live key is revoked. The error surfaces instead,
      // which the error handler answers as a 500 the caller can retry.
      await expect(baseHandler(deleteEvent('key-1'))).rejects.toThrow(TransactionCanceledException);
    },
  );

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
