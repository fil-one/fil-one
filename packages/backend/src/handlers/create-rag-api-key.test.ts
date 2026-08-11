import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

// Full-chain gate tests exercise the REAL ragAccessMiddleware (allowlist check
// against DynamoDB); auth/csrf/subscription are covered by their own suites and
// stubbed to pass-through here so the allowlist gate can be tested in isolation.
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

import { baseHandler, handler } from './create-rag-api-key.js';
import { orgNotDeletingCheck } from '../lib/org-profile.js';
import { hashRagKeyToken, RagApiKeyKeys } from '../lib/rag-api-keys.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';

const USER_INFO = {
  userId: 'user-1',
  orgId: 'org-1',
  email: 'dev@example.com',
  emailVerified: true,
};

function createEvent(body: unknown) {
  return buildEvent({
    userInfo: USER_INFO,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function sentTransactItems() {
  const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
  expect(calls).toHaveLength(1);
  return calls[0].args[0].input.TransactItems ?? [];
}

/**
 * The transaction's WRITE items. Item 0 is always the FIL-112 deletion-guard
 * ConditionCheck (see sendDeletionGuardedWrite); it is asserted on its own below so the
 * key-shape assertions stay about the two rows this handler writes.
 */
function sentWriteItems() {
  return sentTransactItems().slice(1);
}

describe('create-rag-api-key baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ddbMock.on(TransactWriteItemsCommand).resolves({});
  });

  it('returns 201 with a plaintext token exactly once and persists only its hash', async () => {
    const result = await baseHandler(createEvent({ keyName: 'ci key' }));

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body ?? '{}');
    expect(body.token).toMatch(/^sk_rag_[A-Za-z0-9_-]{40,}$/);
    expect(body.keyPrefix).toBe(body.token.slice(0, 12));
    expect(body.keyName).toBe('ci key');
    expect(body.bucketScope).toBe('all');

    const items = sentWriteItems();
    expect(items).toHaveLength(2);
    const orgItem = unmarshall(items[0].Put!.Item!);
    const lookupItem = unmarshall(items[1].Put!.Item!);

    expect(orgItem.pk).toBe(RagApiKeyKeys.orgPk('org-1'));
    expect(orgItem.sk).toBe(RagApiKeyKeys.orgSk(body.id));
    expect(orgItem.tokenHash).toBe(hashRagKeyToken(body.token));
    expect(orgItem.createdBy).toBe('user-1');
    expect(orgItem.creatorEmail).toBe('dev@example.com');
    // The plaintext token must not be stored anywhere.
    expect(JSON.stringify(items)).not.toContain(body.token);

    expect(lookupItem.pk).toBe(RagApiKeyKeys.lookupPk(orgItem.tokenHash));
    expect(lookupItem.sk).toBe(RagApiKeyKeys.lookupSk());
    expect(lookupItem.orgId).toBe('org-1');
    expect(lookupItem.keyId).toBe(body.id);

    // Both puts are guarded against overwriting an existing item.
    expect(items[0].Put!.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(items[1].Put!.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  it('persists (region, name) bucket scope pairs for specific keys', async () => {
    const result = await baseHandler(
      createEvent({
        keyName: 'scoped',
        bucketScope: 'specific',
        buckets: [{ region: 'eu-west-1', name: 'docs' }],
      }),
    );

    expect(result.statusCode).toBe(201);
    const orgItem = unmarshall(sentWriteItems()[0].Put!.Item!);
    expect(orgItem.bucketScope).toBe('specific');
    expect(orgItem.buckets).toEqual([{ region: 'eu-west-1', name: 'docs' }]);
  });

  it('omits creatorEmail when the email is not verified', async () => {
    const event = buildEvent({
      userInfo: { ...USER_INFO, emailVerified: false },
      body: JSON.stringify({ keyName: 'k' }),
    });

    const result = await baseHandler(event);

    expect(result.statusCode).toBe(201);
    const orgItem = unmarshall(sentWriteItems()[0].Put!.Item!);
    expect(orgItem.creatorEmail).toBeUndefined();
  });

  it.each([
    ['invalid JSON', 'not-json{'],
    ['missing key name', {}],
    ['bad key name characters', { keyName: 'bad/name' }],
    ['specific scope without buckets', { keyName: 'k', bucketScope: 'specific' }],
    ['specific scope with empty buckets', { keyName: 'k', bucketScope: 'specific', buckets: [] }],
    [
      'buckets alongside all scope',
      { keyName: 'k', bucketScope: 'all', buckets: [{ region: 'eu-west-1', name: 'docs' }] },
    ],
    [
      'duplicate buckets',
      {
        keyName: 'k',
        bucketScope: 'specific',
        buckets: [
          { region: 'eu-west-1', name: 'docs' },
          { region: 'eu-west-1', name: 'docs' },
        ],
      },
    ],
  ])('returns 400 for %s without writing to DynamoDB', async (_label, body) => {
    const result = await baseHandler(createEvent(body));

    expect(result.statusCode).toBe(400);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('fences the transaction on the org profile deleting flag as item 0', async () => {
    await baseHandler(createEvent({ keyName: 'ci key' }));

    // The expression itself is pinned once, in org-profile.test.ts.
    expect(sentTransactItems()[0]).toEqual(orgNotDeletingCheck('org-1'));
  });

  it('returns 410 ACCOUNT_DELETED and mints nothing when the fence rejects', async () => {
    // Without the fence, `attribute_not_exists(pk)` alone (it only stops key-id
    // collisions) would let this commit a WORKING bearer credential into a
    // partition the teardown has already purged.
    ddbMock.on(TransactWriteItemsCommand).rejects(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'None' },
        ],
      }),
    );

    const result = await baseHandler(createEvent({ keyName: 'ci key' }));

    expect(result.statusCode).toBe(410);
    expect(JSON.parse(result.body ?? '{}')).toMatchObject({ code: 'ACCOUNT_DELETED' });
    // The token is never disclosed when the rows were not written.
    expect(result.body).not.toContain('sk_rag_');
  });

  it('rethrows a key-id collision (a cancellation that is not the fence)', async () => {
    ddbMock.on(TransactWriteItemsCommand).rejects(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [
          { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
        ],
      }),
    );

    await expect(baseHandler(createEvent({ keyName: 'ci key' }))).rejects.toBeInstanceOf(
      TransactionCanceledException,
    );
  });
});

describe('create-rag-api-key handler (allowlist gate)', () => {
  // Non-foundation email so the decision hinges on the allowlist lookup.
  const nonFoundationEvent = () =>
    buildEvent({
      userInfo: {
        userId: 'user-1',
        orgId: 'org-1',
        email: 'outsider@example.com',
        emailVerified: true,
      },
      body: JSON.stringify({ keyName: 'ci key' }),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ddbMock.on(TransactWriteItemsCommand).resolves({});
  });

  it('returns 403 when the caller is not foundation and not allowlisted', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });

    const result = await handler(nonFoundationEvent(), buildContext());

    expect(result.statusCode).toBe(403);
    // No key is minted when the gate denies.
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(0);
  });

  it('allows an allowlisted caller to create a key', async () => {
    ddbMock
      .on(GetItemCommand, {
        Key: { pk: { S: 'ALLOWLIST#outsider@example.com' }, sk: { S: 'RAG' } },
      })
      .resolves({ Item: marshall({ pk: 'ALLOWLIST#outsider@example.com', sk: 'RAG' }) });

    const result = await handler(nonFoundationEvent(), buildContext());

    expect(result.statusCode).toBe(201);
    expect(ddbMock.commandCalls(TransactWriteItemsCommand)).toHaveLength(1);
  });
});
