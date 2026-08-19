import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type CancellationReason,
  type TransactWriteItem,
  type UpdateItemCommandInput,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import pRetry from 'p-retry';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import {
  deletionChallengeKey,
  hashDeletionCode,
  MAX_VERIFY_ATTEMPTS,
} from './deletion-challenge.js';
import { DELETION_STATUS, DELETION_TRIGGER, type DeletionTrigger } from './deletion-record.js';

/** Matches the budget sendDeletionGuardedWrite uses for the same conflict. */
const CONFLICT_RETRY = { retries: 2, minTimeout: 50, randomize: true } as const;

export type ConfirmResult =
  | { outcome: 'confirmed' }
  | { outcome: 'already_deleting' }
  | { outcome: 'code_invalid' }
  | { outcome: 'code_expired_or_locked' };

export interface ConfirmDeletionParams {
  orgId: string;
  requestedByUserId: string;
  code: string;
  salt: string;
}

/**
 * Spends the code, records the deletion and raises every fence — all or
 * nothing. A spent code must never exist without a deletion record behind it,
 * and a deletion record must never exist without the fences up.
 *
 * The 202 the caller returns is made here, not by the teardown: after this
 * commits, the account is already unusable.
 */
export async function confirmAccountDeletion(
  params: ConfirmDeletionParams,
): Promise<ConfirmResult> {
  const now = new Date().toISOString();

  try {
    await pRetry(
      () =>
        getDynamoClient().send(
          new TransactWriteItemsCommand({ TransactItems: createTransactionItems() }),
        ),
      { ...CONFLICT_RETRY, shouldRetry: ({ error }) => isTransactionConflict(error) },
    );
  } catch (err) {
    if (err instanceof TransactionCanceledException) return classifyCancellation(err, now);
    throw err;
  }

  return { outcome: 'confirmed' };

  function createTransactionItems(): TransactWriteItem[] {
    return [
      createSpendChallengeItem(params, now),
      createDeletionRecordItem(
        params.orgId,
        DELETION_TRIGGER.userRequest,
        now,
        params.requestedByUserId,
      ),
      createOrgFenceItem(params.orgId, now),
    ];
  }
}

/**
 * The same deletion, committed without a code to spend: an admin deleting the
 * org's Stripe customer is the standing response to trial abuse and means the
 * account should go.
 *
 * `already_deleting` covers the teardown's own `customer.deleted` echo — the
 * record already exists, the conditional write is refused, and the two triggers
 * converge instead of compounding.
 */
export async function commitStripeTriggeredDeletion(
  orgId: string,
): Promise<{ outcome: 'confirmed' | 'already_deleting' }> {
  const now = new Date().toISOString();

  try {
    await pRetry(
      () =>
        getDynamoClient().send(
          new TransactWriteItemsCommand({
            TransactItems: [
              createDeletionRecordItem(orgId, DELETION_TRIGGER.stripeCustomerDeleted, now),
              createOrgFenceItem(orgId, now),
            ],
          }),
        ),
      { ...CONFLICT_RETRY, shouldRetry: ({ error }) => isTransactionConflict(error) },
    );
  } catch (err) {
    if (
      err instanceof TransactionCanceledException &&
      err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    ) {
      return { outcome: 'already_deleting' };
    }
    throw err;
  }

  return { outcome: 'confirmed' };
}

// Item 0 — the code. Conditional delete rather than read-then-write, so two
// concurrent confirms cannot both spend it.
function createSpendChallengeItem(params: ConfirmDeletionParams, now: string): TransactWriteItem {
  return {
    Delete: {
      TableName: Resource.DeletionChallengeTable.name,
      Key: deletionChallengeKey(params.orgId),
      ConditionExpression:
        'attribute_exists(pk) AND codeHash = :codeHash AND expiresAt > :now AND attempts < :maxAttempts',
      ExpressionAttributeValues: marshall({
        ':codeHash': hashDeletionCode(
          params.orgId,
          params.requestedByUserId,
          params.salt,
          params.code,
        ),
        ':now': now,
        ':maxAttempts': MAX_VERIFY_ATTEMPTS,
      }),
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    },
  };
}

// The record. attribute_not_exists makes a double-confirm — and the teardown's own
// customer.deleted echo — a no-op rather than a second teardown.
function createDeletionRecordItem(
  orgId: string,
  trigger: DeletionTrigger,
  requestedAt: string,
  requestedByUserId?: string,
): TransactWriteItem {
  return {
    Put: {
      TableName: Resource.UserInfoTable.name,
      Item: marshall(
        {
          pk: `ORG#${orgId}`,
          sk: 'DELETION',
          status: DELETION_STATUS.pending,
          trigger,
          requestedAt,
          requestedByUserId,
          attempts: 0,
          updatedAt: requestedAt,
        },
        { removeUndefinedValues: true },
      ),
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  };
}

// Item 2 — the fence. Kills every member's session and refuses new resources.
function createOrgFenceItem(orgId: string, now: string): TransactWriteItem {
  return {
    Update: {
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: `ORG#${orgId}`, sk: 'PROFILE' }),
      UpdateExpression: 'SET deleting = :true, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: marshall({ ':true': true, ':now': now }),
    } satisfies UpdateItemCommandInput,
  };
}

/**
 * CancellationReasons is positional, so reason 0 is always the code and reason
 * 1 always the record — no other item can be mistaken for either.
 */
function classifyCancellation(err: TransactionCanceledException, now: string): ConfirmResult {
  const [challenge, record] = err.CancellationReasons ?? [];

  if (record?.Code === 'ConditionalCheckFailed') return { outcome: 'already_deleting' };
  if (challenge?.Code !== 'ConditionalCheckFailed') throw err;

  // ALL_OLD on item 0 tells us which half of its condition failed, without a
  // follow-up read that a concurrent attempt could have already changed.
  const row = challenge.Item ? unmarshall(challenge.Item) : undefined;
  const spent = typeof row?.attempts === 'number' && row.attempts >= MAX_VERIFY_ATTEMPTS;
  const expired = typeof row?.expiresAt === 'string' && row.expiresAt <= now;
  if (!row || spent || expired) return { outcome: 'code_expired_or_locked' };

  return { outcome: 'code_invalid' };
}

function isTransactionConflict(err: unknown): boolean {
  return (
    err instanceof TransactionCanceledException &&
    (err.CancellationReasons ?? []).some(
      (r: CancellationReason) => r.Code === 'TransactionConflict',
    )
  );
}

/**
 * Consumes one verify attempt. A cancelled transaction increments nothing, so
 * without this the attempt limiter never engages and the code space stays open
 * to guessing.
 */
export async function consumeVerifyAttempt(orgId: string): Promise<void> {
  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: Resource.DeletionChallengeTable.name,
        Key: deletionChallengeKey(orgId),
        UpdateExpression: 'ADD attempts :one',
        ConditionExpression: 'attribute_exists(pk) AND attempts < :maxAttempts',
        ExpressionAttributeValues: marshall({ ':one': 1, ':maxAttempts': MAX_VERIFY_ATTEMPTS }),
      }),
    );
  } catch (err) {
    // Already locked or already gone — the limiter has done its job either way.
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
}
