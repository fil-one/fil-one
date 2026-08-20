import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { DELETION_CODE_LENGTH, DELETION_CODE_TTL_MINUTES } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';

export const MAX_VERIFY_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = 60;

/** Row cleanup only. `expiresAt` governs code validity — the janitor is lazy. */
const ROW_TTL_SECONDS = 60 * 60;

export type CreateChallengeResult =
  | { outcome: 'created'; code: string; expiresAt: string; resendAvailableAt: string }
  | { outcome: 'rate_limited'; resendAvailableAt: string };

/**
 * Issue (or re-issue) the org's deletion code. One live code per org; a
 * re-issue replaces it and resets its verify attempts. `userId` is inside the
 * HMAC input, so a code minted for one admin cannot be spent by another.
 */
export async function createDeletionChallenge(
  orgId: string,
  requestedByUserId: string,
): Promise<CreateChallengeResult> {
  const now = new Date();
  const code = randomInt(0, 10 ** DELETION_CODE_LENGTH)
    .toString()
    .padStart(DELETION_CODE_LENGTH, '0');
  const salt = randomBytes(16).toString('hex');
  const expiresAt = new Date(now.getTime() + DELETION_CODE_TTL_MINUTES * 60 * 1000).toISOString();
  const cooldownMs = RESEND_COOLDOWN_SECONDS * 1000;

  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: Resource.DeletionChallengeTable.name,
        Key: deletionChallengeKey(orgId),
        UpdateExpression:
          'SET codeHash = :codeHash, salt = :salt, attempts = :zero, ' +
          'lastSentAt = :now, expiresAt = :expiresAt, #ttl = :ttl',
        // An upsert, so a row whose TTL has lapsed but which the janitor has not
        // collected is simply overwritten — its lastSentAt is long past.
        ConditionExpression: 'attribute_not_exists(pk) OR lastSentAt < :cooldownCutoff',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: marshall({
          ':codeHash': hashDeletionCode(orgId, requestedByUserId, salt, code),
          ':salt': salt,
          ':zero': 0,
          ':now': now.toISOString(),
          ':expiresAt': expiresAt,
          ':ttl': Math.floor(now.getTime() / 1000) + ROW_TTL_SECONDS,
          ':cooldownCutoff': new Date(now.getTime() - cooldownMs).toISOString(),
        }),
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return {
        outcome: 'rate_limited',
        resendAvailableAt: resendAvailableAt(err, now, cooldownMs),
      };
    }
    throw err;
  }

  return {
    outcome: 'created',
    code,
    expiresAt,
    resendAvailableAt: new Date(now.getTime() + cooldownMs).toISOString(),
  };
}

/**
 * Keyed HMAC rather than a plain salted hash: a table dump alone must not let
 * anyone enumerate a six-digit space offline.
 */
export function hashDeletionCode(
  orgId: string,
  userId: string,
  salt: string,
  code: string,
): string {
  return createHmac('sha256', Resource.DeletionCodeHmacKey.value)
    .update(`${orgId}:${userId}:${salt}:${code}`)
    .digest('hex');
}

export function deletionChallengeKey(orgId: string) {
  return marshall({ pk: `ORG#${orgId}` });
}

/** Read off the rejected row so the caller can say when, not just that. */
function resendAvailableAt(
  err: ConditionalCheckFailedException,
  now: Date,
  cooldownMs: number,
): string {
  const existing = err.Item ? unmarshall(err.Item) : undefined;
  const lastSentMs =
    typeof existing?.lastSentAt === 'string'
      ? new Date(existing.lastSentAt).getTime()
      : now.getTime();
  return new Date(lastSentMs + cooldownMs).toISOString();
}
