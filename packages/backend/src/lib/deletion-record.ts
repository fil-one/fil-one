import { marshall } from '@aws-sdk/util-dynamodb';

export const DELETION_STATUS = { pending: 'PENDING', done: 'DONE' } as const;
export type DeletionStatus = (typeof DELETION_STATUS)[keyof typeof DELETION_STATUS];

/**
 * What committed the deletion. The receipt has to distinguish a user's own
 * request from an admin deleting the org's Stripe customer, which is the standing
 * response to trial abuse, and both from an operator driving the teardown by hand.
 */
export const DELETION_TRIGGER = {
  userRequest: 'USER_REQUEST',
  stripeCustomerDeleted: 'STRIPE_CUSTOMER_DELETED',
  /** An operator ran `bin/account-deletion.ts start`, usually to recover a stuck teardown. */
  operator: 'OPERATOR',
} as const;
export type DeletionTrigger = (typeof DELETION_TRIGGER)[keyof typeof DELETION_TRIGGER];

/** What teardown needs to know about one member, resolved per pass. */
export interface DeletionMember {
  userId: string;
  /** Auth0 subject — the account to delete, and the audit correlation key. */
  sub: string;
  /** Absent is legal, and means there is no Stripe work for this member. */
  stripeCustomerId?: string;
}

/**
 * `UserInfoTable` — `ORG#{orgId}` / `DELETION`. Drives the teardown, then stays
 * forever as the erasure receipt. No TTL, no PII: internal identifiers only.
 */
export interface DeletionRecord {
  status: DeletionStatus;
  trigger: DeletionTrigger;
  requestedAt: string;
  /** Absent for every trigger but `USER_REQUEST`: there is no requester. */
  requestedByUserId?: string;
  /** Worker passes so far; the alarm threshold input. */
  attempts: number;
  updatedAt: string;
}

export function deletionRecordKey(orgId: string) {
  return marshall({ pk: `ORG#${orgId}`, sk: 'DELETION' });
}
