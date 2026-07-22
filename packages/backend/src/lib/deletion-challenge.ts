import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { DELETION_CODE_LENGTH, DELETION_CODE_TTL_MINUTES } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { DeletionKeys } from './dynamo-records.js';

export const MAX_VERIFY_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_SENDS_PER_WINDOW = 5;
/** Row lifetime — also the send-rate window. Codes themselves expire sooner. */
const ROW_TTL_SECONDS = 60 * 60;

export type CreateChallengeResult =
  | { outcome: 'created'; code: string; expiresAt: string; resendAvailableAt: string }
  | { outcome: 'rate_limited'; resendAvailableAt: string };

export type VerifyChallengeResult = 'ok' | 'invalid' | 'expired_or_locked';

function hashCode(orgId: string, salt: string, code: string): string {
  return createHash('sha256').update(`${orgId}:${salt}:${code}`).digest('hex');
}

function challengeKey(orgId: string) {
  return marshall({ pk: DeletionKeys.challengePk(orgId), sk: DeletionKeys.challengeSk() });
}

/**
 * Issue (or re-issue) the org's deletion verification code. One live code per
 * org: a successful re-issue replaces the previous code and resets the verify
 * attempts, but the send count carries across the row's TTL window so codes
 * cannot be requested more than {@link MAX_SENDS_PER_WINDOW} times per hour,
 * with a {@link RESEND_COOLDOWN_SECONDS} cooldown between sends.
 */
export async function createDeletionChallenge(orgId: string): Promise<CreateChallengeResult> {
  const now = new Date();
  const code = randomInt(0, 10 ** DELETION_CODE_LENGTH)
    .toString()
    .padStart(DELETION_CODE_LENGTH, '0');
  const salt = randomBytes(16).toString('hex');
  const expiresAt = new Date(now.getTime() + DELETION_CODE_TTL_MINUTES * 60 * 1000).toISOString();
  const cooldownCutoff = new Date(now.getTime() - RESEND_COOLDOWN_SECONDS * 1000).toISOString();

  // The send counter lives on the row being replaced, so the rate limit is an
  // atomic conditional update: allowed when no row exists, or when the
  // cooldown has elapsed and the window's send budget remains. The window is
  // anchored on the first send (`ttl`/`createdAt` keep their original values).
  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: Resource.BillingTable.name,
        Key: challengeKey(orgId),
        UpdateExpression:
          'SET codeHash = :codeHash, salt = :salt, attempts = :zero, lastSentAt = :now, ' +
          'expiresAt = :expiresAt, createdAt = if_not_exists(createdAt, :now), ' +
          '#ttl = if_not_exists(#ttl, :ttl) ADD sendCount :one',
        ConditionExpression:
          'attribute_not_exists(pk) OR (lastSentAt < :cooldownCutoff AND sendCount < :maxSends)',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: marshall({
          ':codeHash': hashCode(orgId, salt, code),
          ':salt': salt,
          ':zero': 0,
          ':one': 1,
          ':now': now.toISOString(),
          ':expiresAt': expiresAt,
          ':ttl': Math.floor(now.getTime() / 1000) + ROW_TTL_SECONDS,
          ':cooldownCutoff': cooldownCutoff,
          ':maxSends': MAX_SENDS_PER_WINDOW,
        }),
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return rateLimitedResult(err, now);
    }
    throw err;
  }

  return {
    outcome: 'created',
    code,
    expiresAt,
    resendAvailableAt: new Date(now.getTime() + RESEND_COOLDOWN_SECONDS * 1000).toISOString(),
  };
}

/**
 * Build the rate-limited outcome from the rejected row: after the cooldown
 * when send budget remains, otherwise when the row's TTL window ends.
 */
function rateLimitedResult(err: ConditionalCheckFailedException, now: Date): CreateChallengeResult {
  const existing = err.Item ? unmarshall(err.Item) : undefined;
  const lastSentMs = existing?.lastSentAt
    ? new Date(existing.lastSentAt as string).getTime()
    : now.getTime();
  const windowEndMs =
    typeof existing?.ttl === 'number' ? existing.ttl * 1000 : lastSentMs + ROW_TTL_SECONDS * 1000;
  const resendAvailableAt =
    (existing?.sendCount ?? 0) >= MAX_SENDS_PER_WINDOW
      ? new Date(windowEndMs)
      : new Date(lastSentMs + RESEND_COOLDOWN_SECONDS * 1000);
  return { outcome: 'rate_limited', resendAvailableAt: resendAvailableAt.toISOString() };
}

/**
 * Verify a submitted code. An attempt is consumed atomically BEFORE the hash
 * comparison so parallel guesses cannot exceed {@link MAX_VERIFY_ATTEMPTS};
 * once the row is locked or expired every call returns 'expired_or_locked'.
 * A matching code deletes the row (single-use).
 */
export async function verifyDeletionChallenge(
  orgId: string,
  code: string,
): Promise<VerifyChallengeResult> {
  const key = challengeKey(orgId);
  let attrs: Record<string, unknown>;
  try {
    const out = await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: Resource.BillingTable.name,
        Key: key,
        UpdateExpression: 'ADD attempts :one',
        ConditionExpression: 'attribute_exists(pk) AND attempts < :max AND expiresAt > :now',
        ExpressionAttributeValues: marshall({
          ':one': 1,
          ':max': MAX_VERIFY_ATTEMPTS,
          ':now': new Date().toISOString(),
        }),
        ReturnValues: 'ALL_NEW',
      }),
    );
    attrs = unmarshall(out.Attributes!);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return 'expired_or_locked';
    throw err;
  }

  const candidate = Buffer.from(hashCode(orgId, attrs.salt as string, code), 'hex');
  const stored = Buffer.from(attrs.codeHash as string, 'hex');
  if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) {
    return 'invalid';
  }

  // Single-use: a verified code cannot be replayed.
  await getDynamoClient().send(
    new DeleteItemCommand({ TableName: Resource.BillingTable.name, Key: key }),
  );
  return 'ok';
}

/** Remove any lingering challenge row (e.g. during the final org purge). */
export async function deleteDeletionChallenge(orgId: string): Promise<void> {
  await getDynamoClient().send(
    new DeleteItemCommand({ TableName: Resource.BillingTable.name, Key: challengeKey(orgId) }),
  );
}
