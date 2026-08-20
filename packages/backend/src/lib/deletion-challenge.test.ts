import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { DELETION_CODE_LENGTH } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: {
    DeletionChallengeTable: { name: 'DeletionChallengeTable' },
    DeletionCodeHmacKey: { value: 'test-hmac-key' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import {
  createDeletionChallenge,
  hashDeletionCode,
  RESEND_COOLDOWN_SECONDS,
} from './deletion-challenge.js';

const ORG = 'org-1';
const USER = 'user-1';

function sentInput() {
  return ddbMock.commandCalls(UpdateItemCommand)[0]!.args[0].input;
}

describe('createDeletionChallenge', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(UpdateItemCommand).resolves({});
  });

  it('issues a zero-padded code of the shared length', async () => {
    const result = await createDeletionChallenge(ORG, USER);

    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') return;
    expect(result.code).toMatch(new RegExp(`^\\d{${DELETION_CODE_LENGTH}}$`));
  });

  it('writes the hash and salt, never the code', async () => {
    const result = await createDeletionChallenge(ORG, USER);
    if (result.outcome !== 'created') throw new Error('expected created');

    const input = sentInput();
    expect(input.Key).toEqual(marshall({ pk: `ORG#${ORG}` }));
    expect(JSON.stringify(input)).not.toContain(result.code);

    const values = input.ExpressionAttributeValues!;
    expect(values[':codeHash']!.S).toBe(
      hashDeletionCode(ORG, USER, values[':salt']!.S!, result.code),
    );
  });

  it('resets the attempt counter on every issue', async () => {
    await createDeletionChallenge(ORG, USER);

    expect(sentInput().ExpressionAttributeValues![':zero']).toEqual({ N: '0' });
  });

  it('upserts, so a lapsed row the janitor has not collected is reclaimed', async () => {
    await createDeletionChallenge(ORG, USER);

    expect(sentInput().ConditionExpression).toBe(
      'attribute_not_exists(pk) OR lastSentAt < :cooldownCutoff',
    );
  });

  // Binding the code to the requester means a second admin's valid code fails
  // the compare rather than unlocking the org.
  it('binds the hash to org, user and salt', () => {
    const base = hashDeletionCode(ORG, USER, 'salt', '123456');

    expect(hashDeletionCode('org-2', USER, 'salt', '123456')).not.toBe(base);
    expect(hashDeletionCode(ORG, 'user-2', 'salt', '123456')).not.toBe(base);
    expect(hashDeletionCode(ORG, USER, 'other-salt', '123456')).not.toBe(base);
    expect(hashDeletionCode(ORG, USER, 'salt', '654321')).not.toBe(base);
  });

  it('reports when the cooldown lifts, read off the rejected row', async () => {
    const lastSentAt = '2026-08-12T10:00:00.000Z';
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'failed',
        $metadata: {},
        Item: marshall({ pk: `ORG#${ORG}`, lastSentAt }),
      }),
    );

    const result = await createDeletionChallenge(ORG, USER);

    expect(result).toEqual({
      outcome: 'rate_limited',
      resendAvailableAt: new Date(
        new Date(lastSentAt).getTime() + RESEND_COOLDOWN_SECONDS * 1000,
      ).toISOString(),
    });
  });

  it('rethrows anything that is not a condition failure', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('throttled'));

    await expect(createDeletionChallenge(ORG, USER)).rejects.toThrow('throttled');
  });
});
