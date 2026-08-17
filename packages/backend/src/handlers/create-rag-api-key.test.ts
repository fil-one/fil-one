import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

import { sstResourceMock } from '../test/sst-resource-mock.js';
import { auditItemIn, expectNoSecrets } from '../test/audit-assertions.js';

vi.mock('sst', () => sstResourceMock());

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './create-rag-api-key.js';
import { OrgDeletingError } from '../lib/org-profile.js';
import { hashRagKeyToken, RagApiKeyKeys } from '../lib/rag-api-keys.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

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

/** The caller's items, with the deletion guard — always item 0 — asserted and stripped. */
function sentTransactItems() {
  const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
  expect(calls).toHaveLength(1);
  const items = calls[0].args[0].input.TransactItems ?? [];
  expect(items[0]?.ConditionCheck).toMatchObject({
    Key: { pk: { S: `ORG#${USER_INFO.orgId}` }, sk: { S: 'PROFILE' } },
    ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleting)',
  });
  return items.slice(1);
}

describe('create-rag-api-key baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    ddbMock.on(TransactWriteItemsCommand).resolves({});
  });

  // The 410 itself is errorHandlerMiddleware's job, so the handler's contract
  // is simply that it refuses rather than persisting anything.
  it('throws OrgDeletingError when the guard refuses a deleting org', async () => {
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

    await expect(baseHandler(createEvent({ keyName: 'ci key' }))).rejects.toBeInstanceOf(
      OrgDeletingError,
    );
  });

  it('returns 201 with a plaintext token exactly once and persists only its hash', async () => {
    const result = await baseHandler(createEvent({ keyName: 'ci key' }));

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body ?? '{}');
    expect(body.token).toMatch(/^sk_rag_[A-Za-z0-9_-]{40,}$/);
    expect(body.keyPrefix).toBe(body.token.slice(0, 12));
    expect(body.keyName).toBe('ci key');
    expect(body.bucketScope).toBe('all');

    const items = sentTransactItems();
    expect(items).toHaveLength(3);
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

  it('records the mint in the same transaction as the rows', async () => {
    const result = await baseHandler(createEvent({ keyName: 'ci key' }));

    const body = JSON.parse(result.body ?? '{}');
    const items = sentTransactItems();
    const auditItem = auditItemIn(items);
    const event = unmarshall(auditItem);

    expect(
      items.find((item) => item.Put?.TableName === 'AuditTable')!.Put!.ConditionExpression,
    ).toBe('attribute_not_exists(pk)');
    expect(event).toMatchObject({
      pk: 'ORG#org-1',
      type: 'key.created',
      orgId: 'org-1',
      subject: `key:${body.id}`,
      actor: { kind: 'user', id: 'user-1', email: 'dev@example.com' },
      // The display prefix, which is what the console lists a RAG key by, so an
      // operator reading the event can find the key it names.
      details: { keyKind: 'rag', keyName: 'ci key', keyIdSuffix: body.keyPrefix },
    });
    // Minted here rather than at a vendor, so the whole mutation is one
    // transaction and there is no intent to correlate.
    expect(event.phase).toBeUndefined();
    // The token itself never reaches the log — twelve of its fifty characters
    // are the console's label, not the credential.
    expect(JSON.stringify(event)).not.toContain(body.token);
    expect(event.details.keyIdSuffix).toHaveLength(12);
    expectNoSecrets(auditItem);
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
    const orgItem = unmarshall(sentTransactItems()[0].Put!.Item!);
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
    const orgItem = unmarshall(sentTransactItems()[0].Put!.Item!);
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
});
