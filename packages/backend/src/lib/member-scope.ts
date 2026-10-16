import { OrgRole } from '@filone/shared';

/**
 * The member a console request on an `iam` region acts as, or undefined for a
 * caller the console serves unscoped. Owner and Admin are unscoped by role: the
 * console reads and signs for them with the tenant's key, so a bucket whose
 * policy leaves them out, or has none, is still theirs to open and repair. Their
 * own keys still answer to the policy at the storage system.
 *
 * This asks who is unscoped, which `isRosterRole` only happens to answer today.
 */
export function getScopedMemberId(role: OrgRole | undefined, userId: string): string | undefined {
  return role === OrgRole.Owner || role === OrgRole.Admin ? undefined : userId;
}
