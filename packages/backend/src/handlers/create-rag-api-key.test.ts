import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './create-rag-api-key.js';
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

function sentTransactItems() {
  const calls = ddbMock.commandCalls(TransactWriteItemsCommand);
  expect(calls).toHaveLength(1);
  return calls[0].args[0].input.TransactItems ?? [];
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

    const items = sentTransactItems();
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
