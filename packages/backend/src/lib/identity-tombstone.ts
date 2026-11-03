import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.ts';
import { DELETION_STATUS, deletionRecordKey } from './deletion-record.ts';

/**
 * A deleted user's `SUB#{sub}/IDENTITY` row is kept, because
 * `createNewUserAndOrg` claims that key with `attribute_not_exists(pk)` —
 * removing the row would let the same Auth0 sub sign up again into a fresh org.
 * Accepting an invitation is the one way back in, and it replaces the row
 * (`inviteeAccountRows`).
 *
 * `deletedAt` alone answers both whether the row is deleted and when. A separate
 * boolean beside it could only drift out of agreement with it.
 *
 * A type guard: after a true answer the compiler knows the row exists and
 * `deletedAt.S` is a string, so callers read the stamp without asserting it.
 */
export function isIdentityTombstoned(
  identityRow: Record<string, AttributeValue> | undefined,
): identityRow is TombstonedIdentityRow {
  return identityRow?.deletedAt?.S !== undefined;
}

export type TombstonedIdentityRow = Record<string, AttributeValue> & {
  deletedAt: AttributeValue.SMember;
};

/** Thrown when an authenticated request presents a tombstoned identity. */
export class AccountDeletedError extends Error {
  constructor() {
    super('Account has been deleted');
    this.name = 'AccountDeletedError';
  }
}

/**
 * Thrown in place of {@link AccountDeletedError} on a route that lets a deleted
 * account start over, while that account's deletion is still running. The
 * answer there is "try again shortly", not "this account is gone".
 *
 * A subclass, so every path that passes a deleted account through as a decision
 * rather than a token failure passes this one through too.
 *
 * `deleting` says what the caller is waiting on. An identity already stamped is
 * an account being deleted. A home org still being torn down is an organization
 * being deleted, which is all that is true for a member who survives it.
 */
export class AccountDeletionInProgressError extends AccountDeletedError {
  readonly deleting: DeletionInProgress;

  constructor(deleting: DeletionInProgress) {
    super();
    this.name = 'AccountDeletionInProgressError';
    this.deleting = deleting;
  }
}

export type DeletionInProgress = 'account' | 'organization';

/**
 * Whether the teardown of `orgId` has finished. The scrub stamps the identity
 * row before the teardown's last steps run, so a tombstone alone does not say
 * the account is gone. Consistent, because the worker marks the record done
 * moments before a caller may come back.
 */
export async function hasDeletionFinished(orgId: string): Promise<boolean> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: deletionRecordKey(orgId),
      ConsistentRead: true,
    }),
  );
  return Item?.status?.S === DELETION_STATUS.done;
}

/**
 * The userId of the account `sub` holds now, or undefined when it holds none or
 * only a deleted one. Consistent, because it is read straight after a write that
 * may have created the account.
 */
export async function readLiveAccountUserId(sub: string): Promise<string | undefined> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `SUB#${sub}` }, sk: { S: 'IDENTITY' } },
      ProjectionExpression: 'userId, deletedAt',
      ConsistentRead: true,
    }),
  );
  if (isIdentityTombstoned(Item)) return undefined;
  return Item?.userId?.S;
}
