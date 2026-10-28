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
 */
export class AccountDeletionInProgressError extends AccountDeletedError {
  constructor() {
    super();
    this.name = 'AccountDeletionInProgressError';
  }
}

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
