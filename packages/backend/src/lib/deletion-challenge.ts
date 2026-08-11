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
import { DeletionKeys, type DeletionChallengeRecord } from './dynamo-records.js';

export const MAX_VERIFY_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_SENDS_PER_WINDOW = 5;
/** Row lifetime — also the send-rate window. Codes themselves expire sooner. */
const ROW_TTL_SECONDS = 60 * 60;

type CreateChallengeResult =
  | { outcome: 'created'; code: string; expiresAt: string; resendAvailableAt: string }
  | { outcome: 'rate_limited'; resendAvailableAt: string };

type VerifyChallengeResult = 'ok' | 'invalid' | 'expired_or_locked';

/**
 * The code is bound to the requester, not just the org: `userId` is part of the
 * hash input, so a code minted for one admin cannot be confirmed by another. A
 * different admin submitting a perfectly valid code fails the compare and gets
 * the same answer as a wrong code.
 */
function hashCode(orgId: string, userId: string, salt: string, code: string): string {
  return createHash('sha256').update(`${orgId}:${userId}:${salt}:${code}`).digest('hex');
}

function challengeKey(orgId: string) {
  return marshall({ pk: DeletionKeys.challengePk(orgId), sk: DeletionKeys.challengeSk() });
}

/**
 * Issue (or re-issue) the org's deletion code. One live code per org: re-issue
 * resets the verify attempts, but the send count carries across the row's TTL
 * window to cap sends at {@link MAX_SENDS_PER_WINDOW} per hour.
 *
 * The code is emailed to the requester's own session address and only they can
 * confirm with it (see {@link hashCode}), so a re-issue by a second admin
 * supersedes the first admin's code rather than sharing it.
 */
export async function createDeletionChallenge(
  orgId: string,
  requestedByUserId: string,
): Promise<CreateChallengeResult> {
  const now = new Date();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const code = randomInt(0, 10 ** DELETION_CODE_LENGTH)
    .toString()
    .padStart(DELETION_CODE_LENGTH, '0');
  const salt = randomBytes(16).toString('hex');
  const expiresAt = new Date(now.getTime() + DELETION_CODE_TTL_MINUTES * 60 * 1000).toISOString();
  const cooldownCutoff = new Date(now.getTime() - RESEND_COOLDOWN_SECONDS * 1000).toISOString();
  let issuedExpiresAt = expiresAt;

  // Two atomic conditional updates, because the send counter lives on the row
  // being replaced. DynamoDB's TTL janitor deletes expired rows lazily (hours
  // late), so phase 1 must reclaim a lapsed row rather than let it keep
  // blocking sends; only a live window reaches phase 2's cooldown/budget.
  try {
    // Phase 1 — start a fresh window: no row, or the row's TTL has lapsed.
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: Resource.BillingTable.name,
        Key: challengeKey(orgId),
        UpdateExpression:
          'SET codeHash = :codeHash, salt = :salt, attempts = :zero, lastSentAt = :now, ' +
          'expiresAt = :expiresAt, createdAt = :now, #ttl = :ttl, sendCount = :one',
        ConditionExpression: 'attribute_not_exists(pk) OR #ttl <= :nowEpoch',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: marshall({
          ':codeHash': hashCode(orgId, requestedByUserId, salt, code),
          ':salt': salt,
          ':zero': 0,
          ':one': 1,
          ':now': now.toISOString(),
          ':expiresAt': expiresAt,
          ':ttl': nowEpoch + ROW_TTL_SECONDS,
          ':nowEpoch': nowEpoch,
        }),
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    // The row can vanish at window end, so a resent code must never claim to
    // outlive it: clamp the stated expiry to min(now + code TTL, window end).
    const liveRow = err.Item ? unmarshall(err.Item) : undefined;
    const windowEndMs = typeof liveRow?.ttl === 'number' ? liveRow.ttl * 1000 : undefined;
    if (windowEndMs !== undefined && windowEndMs < new Date(expiresAt).getTime()) {
      issuedExpiresAt = new Date(windowEndMs).toISOString();
    }
    // Phase 2 — resend within the live window. The `#ttl > :nowEpoch` guard
    // keeps this from racing a concurrent phase-1 reclaim onto a stale window.
    try {
      await getDynamoClient().send(
        new UpdateItemCommand({
          TableName: Resource.BillingTable.name,
          Key: challengeKey(orgId),
          UpdateExpression:
            'SET codeHash = :codeHash, salt = :salt, attempts = :zero, lastSentAt = :now, ' +
            'expiresAt = :expiresAt ADD sendCount :one',
          ConditionExpression:
            '(attribute_not_exists(#ttl) OR #ttl > :nowEpoch) AND ' +
            'lastSentAt < :cooldownCutoff AND sendCount < :maxSends',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: marshall({
            ':codeHash': hashCode(orgId, requestedByUserId, salt, code),
            ':salt': salt,
            ':zero': 0,
            ':one': 1,
            ':now': now.toISOString(),
            ':expiresAt': issuedExpiresAt,
            ':nowEpoch': nowEpoch,
            ':cooldownCutoff': cooldownCutoff,
            ':maxSends': MAX_SENDS_PER_WINDOW,
          }),
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
    } catch (resendErr) {
      if (resendErr instanceof ConditionalCheckFailedException) {
        return rateLimitedResult(resendErr, now);
      }
      throw resendErr;
    }
  }

  return {
    outcome: 'created',
    code,
    expiresAt: issuedExpiresAt,
    resendAvailableAt: new Date(now.getTime() + RESEND_COOLDOWN_SECONDS * 1000).toISOString(),
  };
}

/** Retry-after from the rejected row: cooldown end, or window end if out of budget. */
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
 * Verify a submitted code. The attempt is consumed atomically BEFORE the hash
 * comparison so parallel guesses cannot exceed {@link MAX_VERIFY_ATTEMPTS}.
 *
 * `userId` is the submitter. A code issued to a different admin cannot be
 * confirmed here — it fails the compare and reads as `invalid`, indistinguishable
 * from a wrong code. That costs the submitter one attempt, which is the same
 * price any wrong code pays.
 */
export async function verifyDeletionChallenge(
  orgId: string,
  userId: string,
  code: string,
): Promise<VerifyChallengeResult> {
  const key = challengeKey(orgId);
  let attrs: Pick<DeletionChallengeRecord, 'codeHash' | 'salt'>;
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
    attrs = unmarshall(out.Attributes!) as Pick<DeletionChallengeRecord, 'codeHash' | 'salt'>;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return 'expired_or_locked';
    throw err;
  }

  const candidate = Buffer.from(hashCode(orgId, userId, attrs.salt, code), 'hex');
  const stored = Buffer.from(attrs.codeHash, 'hex');
  if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) {
    return 'invalid';
  }

  // Single-use, and single-use of THIS code. Conditioning on the hash just
  // verified covers both races: a concurrent verify that already consumed the row
  // wins and this one fails, and a resend that replaced the code mid-verify is
  // not destroyed by this delete — otherwise accepting the superseded code would
  // also burn the fresh one. Existence is implied by the equality.
  try {
    await getDynamoClient().send(
      new DeleteItemCommand({
        TableName: Resource.BillingTable.name,
        Key: key,
        ConditionExpression: 'codeHash = :verified',
        ExpressionAttributeValues: marshall({ ':verified': attrs.codeHash }),
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return 'invalid';
    throw err;
  }
  return 'ok';
}

/** Remove any lingering challenge row (e.g. during the final org purge). */
export async function deleteDeletionChallenge(orgId: string): Promise<void> {
  await getDynamoClient().send(
    new DeleteItemCommand({ TableName: Resource.BillingTable.name, Key: challengeKey(orgId) }),
  );
}
