import { marshall } from '@aws-sdk/util-dynamodb';

export const DELETION_STATUS = { pending: 'PENDING', done: 'DONE' } as const;
export type DeletionStatus = (typeof DELETION_STATUS)[keyof typeof DELETION_STATUS];

/**
 * A member as of confirm time. Everything teardown needs about them, because
 * the rows these were read from are destroyed by the purge.
 */
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
  requestedAt: string;
  requestedByUserId: string;
  members: DeletionMember[];
  /** `orchestratorId` → `tenantId`, snapshotted while the profile still exists. */
  tenantIds: Record<string, string>;
  /** Worker passes so far; the alarm threshold input. */
  attempts: number;
  updatedAt: string;
}

export function deletionRecordKey(orgId: string) {
  return marshall({ pk: `ORG#${orgId}`, sk: 'DELETION' });
}
