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
const USER_ID = 'user-requester';
/** A second admin of the same org — holds no valid code of their own. */
const OTHER_ADMIN = 'user-other-admin';

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
    codeHash: createHash('sha256').update(`${ORG_ID}:${USER_ID}:${salt}:${code}`).digest('hex'),
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

  it('issues a 6-digit code and opens a fresh window (SET sendCount = 1, fresh ttl)', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});
    const before = Math.floor(Date.now() / 1000);

    const result = await createDeletionChallenge(ORG_ID, USER_ID);

    if (result.outcome !== 'created')
      expect.unreachable(`expected outcome=created, got ${result.outcome}`);
    expect(result.code).toMatch(/^\d{6}$/);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(result.resendAvailableAt).getTime()).toBeGreaterThan(Date.now());

    const calls = ddbMock.commandCalls(UpdateItemCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    // Phase 1 opens a window, so sendCount is SET to 1, never ADDed onto a stale
    // counter, and the ttl is fresh. The condition also accepts a row whose ttl
    // has lapsed — that is how a physically expired row gets reclaimed rather
    // than blocking sends until the TTL janitor gets around to it.
    expect(input.UpdateExpression).toContain('sendCount = :one');
    expect(input.UpdateExpression).not.toContain('ADD sendCount');
    expect(input.UpdateExpression).toContain('#ttl = :ttl');
    expect(input.ConditionExpression).toBe('attribute_not_exists(pk) OR #ttl <= :nowEpoch');
    expect(Number(input.ExpressionAttributeValues?.[':ttl'].N)).toBeGreaterThanOrEqual(
      before + 3600,
    );
    expect(Number(input.ExpressionAttributeValues?.[':nowEpoch'].N)).toBeGreaterThanOrEqual(before);
    // The plaintext code is never stored — only a salted hash.
    expect(JSON.stringify(input.ExpressionAttributeValues)).not.toContain(result.code);
  });

  it('falls back to an in-window resend guarded by a live ttl when the fresh-window write is rejected', async () => {
    ddbMock.on(UpdateItemCommand).rejectsOnce(conditionalFailure()).resolves({});

    const result = await createDeletionChallenge(ORG_ID, USER_ID);

    expect(result.outcome).toBe('created');
    const calls = ddbMock.commandCalls(UpdateItemCommand);
    expect(calls).toHaveLength(2);
    const input = calls[1].args[0].input;
    expect(input.UpdateExpression).toContain('ADD sendCount :one');
    expect(input.UpdateExpression).not.toContain('#ttl = :ttl');
    expect(input.ConditionExpression).toBe(
      '(attribute_not_exists(#ttl) OR #ttl > :nowEpoch) AND ' +
        'lastSentAt < :cooldownCutoff AND sendCount < :maxSends',
    );
    expect(input.ExpressionAttributeValues?.[':maxSends']).toEqual({
      N: String(MAX_SENDS_PER_WINDOW),
    });
  });

  it('clamps a resent code expiry to the window end so it never outlives the row', async () => {
    // Window ends in 5 minutes — sooner than the code's normal TTL.
    const windowEnd = Math.floor(Date.now() / 1000) + 5 * 60;
    ddbMock
      .on(UpdateItemCommand)
      .rejectsOnce(
        conditionalFailure(
          challengeAttrs({
            lastSentAt: new Date(Date.now() - 120_000).toISOString(),
            ttl: windowEnd,
          }),
        ),
      )
      .resolves({});

    const result = await createDeletionChallenge(ORG_ID, USER_ID);

    if (result.outcome !== 'created')
      expect.unreachable(`expected outcome=created, got ${result.outcome}`);
    expect(result.expiresAt).toBe(new Date(windowEnd * 1000).toISOString());
    // The stored expiry is clamped too, not just the reported one.
    const input = ddbMock.commandCalls(UpdateItemCommand)[1].args[0].input;
    expect(input.ExpressionAttributeValues?.[':expiresAt']).toEqual({
      S: new Date(windowEnd * 1000).toISOString(),
    });
  });

  it('returns rate_limited with resend time on cooldown rejection', async () => {
    const lastSentAt = new Date().toISOString();
    ddbMock
      .on(UpdateItemCommand)
      .rejects(conditionalFailure(challengeAttrs({ lastSentAt, sendCount: 2 })));

    const result = await createDeletionChallenge(ORG_ID, USER_ID);

    if (result.outcome !== 'rate_limited')
      expect.unreachable(`expected outcome=rate_limited, got ${result.outcome}`);
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

    const result = await createDeletionChallenge(ORG_ID, USER_ID);

    if (result.outcome !== 'rate_limited')
      expect.unreachable(`expected outcome=rate_limited, got ${result.outcome}`);
    expect(new Date(result.resendAvailableAt).getTime()).toBe(windowEnd * 1000);
  });

  it('rethrows non-conditional errors', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('throttled'));

    await expect(createDeletionChallenge(ORG_ID, USER_ID)).rejects.toThrow('throttled');
  });

  it('rethrows non-conditional errors from the in-window resend', async () => {
    ddbMock.on(UpdateItemCommand).rejectsOnce(conditionalFailure()).rejects(new Error('throttled'));

    await expect(createDeletionChallenge(ORG_ID, USER_ID)).rejects.toThrow('throttled');
  });
});

describe('verifyDeletionChallenge', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('consumes an attempt atomically before comparing (condition on attempts + expiry)', async () => {
    ddbMock.on(UpdateItemCommand).resolves({ Attributes: marshall(challengeAttrs()) });
    ddbMock.on(DeleteItemCommand).resolves({});

    const result = await verifyDeletionChallenge(ORG_ID, USER_ID, '123456');

    expect(result).toBe('ok');
    const input = ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.UpdateExpression).toBe('ADD attempts :one');
    expect(input.ConditionExpression).toContain('attempts < :max');
    expect(input.ConditionExpression).toContain('expiresAt > :now');
    expect(input.ExpressionAttributeValues?.[':max']).toEqual({
      N: String(MAX_VERIFY_ATTEMPTS),
    });
    // Single-use: the row is deleted on success, and the delete names the hash it
    // just verified so a resend that replaced the code is not destroyed by it.
    const del = ddbMock.commandCalls(DeleteItemCommand)[0].args[0].input;
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(1);
    expect(del.ConditionExpression).toBe('codeHash = :verified');
    expect(del.ExpressionAttributeValues?.[':verified']).toEqual({
      S: challengeAttrs().codeHash,
    });
  });

  it('rejects another admin submitting a valid code, exactly like a wrong code (T-F92)', async () => {
    // The challenge is requester-bound: any admin's code confirming the deletion
    // would let one admin complete another's irreversible action.
    ddbMock.on(UpdateItemCommand).resolves({ Attributes: marshall(challengeAttrs()) });
    ddbMock.on(DeleteItemCommand).resolves({});

    const result = await verifyDeletionChallenge(ORG_ID, OTHER_ADMIN, '123456');

    expect(result).toBe('invalid');
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
  });

  it('returns invalid for a wrong code and does not delete the row', async () => {
    ddbMock.on(UpdateItemCommand).resolves({ Attributes: marshall(challengeAttrs()) });

    const result = await verifyDeletionChallenge(ORG_ID, USER_ID, '654321');

    expect(result).toBe('invalid');
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
  });

  it('returns invalid when the row no longer holds the verified code', async () => {
    // Covers both races the hash condition closes: a concurrent verify that
    // already consumed the row, and a resend that replaced the code mid-verify —
    // in which case this delete must NOT fire, or accepting the superseded code
    // would destroy the fresh one.
    ddbMock.on(UpdateItemCommand).resolves({ Attributes: marshall(challengeAttrs()) });
    ddbMock.on(DeleteItemCommand).rejects(conditionalFailure());

    const result = await verifyDeletionChallenge(ORG_ID, USER_ID, '123456');

    expect(result).toBe('invalid');
    const input = ddbMock.commandCalls(DeleteItemCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBe('codeHash = :verified');
    expect(input.ExpressionAttributeValues?.[':verified']).toEqual({
      S: challengeAttrs().codeHash,
    });
  });

  it('rethrows non-conditional errors from the consuming delete', async () => {
    ddbMock.on(UpdateItemCommand).resolves({ Attributes: marshall(challengeAttrs()) });
    ddbMock.on(DeleteItemCommand).rejects(new Error('throttled'));

    await expect(verifyDeletionChallenge(ORG_ID, USER_ID, '123456')).rejects.toThrow('throttled');
  });

  it('returns expired_or_locked when the attempt-consumption condition fails', async () => {
    ddbMock.on(UpdateItemCommand).rejects(conditionalFailure());

    const result = await verifyDeletionChallenge(ORG_ID, USER_ID, '123456');

    expect(result).toBe('expired_or_locked');
  });

  it('rethrows non-conditional errors', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('throttled'));

    await expect(verifyDeletionChallenge(ORG_ID, USER_ID, '123456')).rejects.toThrow('throttled');
  });
});
