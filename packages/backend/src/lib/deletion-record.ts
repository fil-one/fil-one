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

/**
 * Why this org's deletion leaves a member's account standing. Three conditions
 * reach the same `deleteIdentity: false`, and they are not the same event: one
 * is an ordinary multi-org member, one is somebody who was only ever invited
 * here, and one is a census that could not read a membership row and failed
 * closed. The teardown log names which.
 */
export const DELETION_KEEP_REASON = {
  otherMemberships: 'OTHER_MEMBERSHIPS',
  invitedMember: 'INVITED_MEMBER',
  undecodableMemberships: 'UNDECODABLE_MEMBERSHIPS',
} as const;
export type DeletionKeepReason = (typeof DELETION_KEEP_REASON)[keyof typeof DELETION_KEEP_REASON];

/** What teardown needs to know about one member, resolved per pass. */
export interface DeletionMember {
  userId: string;
  /** Auth0 subject — the account to delete, and the audit correlation key. */
  sub: string;
  /** Absent is legal, and means there is no Stripe work for this member. */
  stripeCustomerId?: string;
  /**
   * Whether deleting this org also ends this person's account: their Auth0 user
   * goes, their identity row is tombstoned, their profile is stamped and their
   * allowlist row is revoked. True only when this org is the member's sole
   * membership and their own personal org; a member who was invited here, or who
   * belongs to another org, keeps all of that and loses only their rows in this
   * org.
   *
   * The census runs once per pass, in `resolveDeletionTargets`, so the Auth0 step
   * and the scrub act on the same answer rather than each running their own. It
   * is not a permanent verdict: a later pass reads the memberships as they stand
   * then and may decide the other way — a membership created or removed between
   * passes changes the answer, and a pass that cannot decode a membership row
   * keeps the account. Every step this flag gates is therefore safe to skip on
   * one pass and take on the next.
   *
   * Billing is not gated on this flag. Both the Stripe teardown and the billing
   * scrub still act on every member, because the billing row is keyed by user
   * today and is re-keyed to the org by its own change.
   */
  deleteIdentity: boolean;
  /**
   * Where a surviving member's account moves. Their identity row and user
   * profile name this org as their home, and every request is fenced on that
   * orgId before any header can override it, so a member left naming a deleted
   * org can never log in again.
   *
   * Set only for a member whose account outlives the org (`deleteIdentity` is
   * false) and who has another membership to move to: the one they joined
   * earliest, and the smallest org id among those they joined at the same
   * moment. Chosen here so both rows move to the same org and a re-driven pass
   * makes the same choice.
   */
  homeOrgId?: string;
  /**
   * Every census condition that kept this account, in the order they are
   * tested. Empty when `deleteIdentity` is true. More than one can hold at
   * once, and the teardown log prints them all — collapsing them to the first
   * would report an invited member as an ordinary multi-org one.
   */
  keptReasons?: DeletionKeepReason[];
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
