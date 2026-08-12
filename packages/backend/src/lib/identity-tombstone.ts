import type { AttributeValue } from '@aws-sdk/client-dynamodb';

/**
 * A deleted user's `SUB#{sub}/IDENTITY` row is stripped of its PII but kept,
 * because `createNewUserAndOrg` claims that key with `attribute_not_exists(pk)`
 * — removing the row would let the same Auth0 sub sign up again into a fresh
 * org. The tombstone is also what makes a stale-but-valid session fail.
 */
export function isIdentityTombstoned(
  identityRow: Record<string, AttributeValue> | undefined,
): boolean {
  return identityRow?.deleted?.BOOL === true;
}

/** Thrown when an authenticated request presents a tombstoned identity. */
export class AccountDeletedError extends Error {
  constructor() {
    super('Account has been deleted');
    this.name = 'AccountDeletedError';
  }
}
