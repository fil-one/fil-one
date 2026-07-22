import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { createHash } from 'node:crypto';

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import {
  createDeletionChallenge,
  verifyDeletionChallenge,
  MAX_VERIFY_ATTEMPTS,
  MAX_SENDS_PER_WINDOW,
  RESEND_COOLDOWN_SECONDS,
} from './deletion-challenge.js';

const ORG_ID = 'org-123';

function conditionalFailure(item?: Record<string, unknown>) {
  return new ConditionalCheckFailedException({
    message: 'The conditional request failed',
    $metadata: {},
    ...(item ? { Item: marshall(item) } : {}),
  });
}

function challengeAttrs(overrides?: Record<string, unknown>) {
  const salt = 'ab'.repeat(16);
  const code = '123456';
  return {
    pk: `DELETION_CHALLENGE#${ORG_ID}`,
    sk: 'CHALLENGE',
    codeHash: createHash('sha256').update(`${ORG_ID}:${salt}:${code}`).digest('hex'),
    salt,
    attempts: 1,
    sendCount: 1,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('createDeletionChallenge', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('issues a 6-digit code with expiry and resend timestamps', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await createDeletionChallenge(ORG_ID);

    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') throw new Error('unreachable');
    expect(result.code).toMatch(/^\d{6}$/);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(result.resendAvailableAt).getTime()).toBeGreaterThan(Date.now());

    const input = ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.ConditionExpression).toContain('attribute_not_exists(pk)');
    expect(input.ConditionExpression).toContain('sendCount < :maxSends');
    // The plaintext code is never stored — only a salted hash.
    expect(JSON.stringify(input.ExpressionAttributeValues)).not.toContain(result.code);
  });

  it('returns rate_limited with resend time on cooldown rejection', async () => {
    const lastSentAt = new Date().toISOString();
    ddbMock
      .on(UpdateItemCommand)
      .rejects(conditionalFailure(challengeAttrs({ lastSentAt, sendCount: 2 })));

    const result = await createDeletionChallenge(ORG_ID);

    expect(result.outcome).toBe('rate_limited');
    if (result.outcome !== 'rate_limited') throw new Error('unreachable');
    expect(new Date(result.resendAvailableAt).getTime()).toBeCloseTo(
      new Date(lastSentAt).getTime() + RESEND_COOLDOWN_SECONDS * 1000,
      -3,
    );
  });

  it('returns rate_limited until the window ends when the send budget is exhausted', async () => {
    const windowEnd = Math.floor(Date.now() / 1000) + 1800;
    ddbMock.on(UpdateItemCommand).rejects(
      conditionalFailure(
        challengeAttrs({
          lastSentAt: new Date().toISOString(),
          sendCount: MAX_SENDS_PER_WINDOW,
          ttl: windowEnd,
        }),
      ),
    );

    const result = await createDeletionChallenge(ORG_ID);

    expect(result.outcome).toBe('rate_limited');
    if (result.outcome !== 'rate_limited') throw new Error('unreachable');
    expect(new Date(result.resendAvailableAt).getTime()).toBe(windowEnd * 1000);
  });

  it('rethrows non-conditional errors', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('throttled'));

    await expect(createDeletionChallenge(ORG_ID)).rejects.toThrow('throttled');
  });
});

describe('verifyDeletionChallenge', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('consumes an attempt atomically before comparing (condition on attempts + expiry)', async () => {
    ddbMock.on(UpdateItemCommand).resolves({ Attributes: marshall(challengeAttrs()) });
    ddbMock.on(DeleteItemCommand).resolves({});

    const result = await verifyDeletionChallenge(ORG_ID, '123456');

    expect(result).toBe('ok');
    const input = ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.UpdateExpression).toBe('ADD attempts :one');
    expect(input.ConditionExpression).toContain('attempts < :max');
    expect(input.ConditionExpression).toContain('expiresAt > :now');
    expect(input.ExpressionAttributeValues?.[':max']).toEqual({
      N: String(MAX_VERIFY_ATTEMPTS),
    });
    // Single-use: the row is deleted on success.
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(1);
  });

  it('returns invalid for a wrong code and does not delete the row', async () => {
    ddbMock.on(UpdateItemCommand).resolves({ Attributes: marshall(challengeAttrs()) });

    const result = await verifyDeletionChallenge(ORG_ID, '654321');

    expect(result).toBe('invalid');
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
  });

  it('returns expired_or_locked when the attempt-consumption condition fails', async () => {
    ddbMock.on(UpdateItemCommand).rejects(conditionalFailure());

    const result = await verifyDeletionChallenge(ORG_ID, '123456');

    expect(result).toBe('expired_or_locked');
  });

  it('rethrows non-conditional errors', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('throttled'));

    await expect(verifyDeletionChallenge(ORG_ID, '123456')).rejects.toThrow('throttled');
  });
});
