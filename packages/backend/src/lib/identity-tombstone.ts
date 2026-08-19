import type { AttributeValue } from '@aws-sdk/client-dynamodb';

/**
 * A deleted user's `SUB#{sub}/IDENTITY` row is kept, because
 * `createNewUserAndOrg` claims that key with `attribute_not_exists(pk)` —
 * removing the row would let the same Auth0 sub sign up again into a fresh org.
 *
 * `deletedAt` alone answers both whether the row is deleted and when. A separate
 * boolean beside it could only drift out of agreement with it.
 */
export function isIdentityTombstoned(
  identityRow: Record<string, AttributeValue> | undefined,
): boolean {
  return identityRow?.deletedAt?.S !== undefined;
}

/** Thrown when an authenticated request presents a tombstoned identity. */
export class AccountDeletedError extends Error {
  constructor() {
    super('Account has been deleted');
    this.name = 'AccountDeletedError';
  }
}
