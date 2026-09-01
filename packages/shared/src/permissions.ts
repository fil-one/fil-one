import { OrgRole, isOrgRole } from './api/org.js';

/**
 * The console permission registry: the vocabulary every authorization check
 * speaks, plus the fixed role → permission table behind it.
 *
 * Four roles and a closed permission set need no policy engine, so this is
 * plain data — a string-literal union and a fixed table. The backend's
 * `authorize()` middleware reads it on every gated route, and `/api/me` ships
 * the caller's set to the console on `MeResponse.permissions` so the UI can
 * hide what the server would refuse.
 *
 * Nothing here is customer-authored or runtime-editable. Changing a role's
 * capabilities means changing {@link ROLE_PERMISSIONS}.
 */
export const PERMISSIONS = [
  /** View the org's member list (names and roles). */
  'members.read',
  /** Invite, change roles, and remove members — targets at Admin and below. */
  'members.manage',
  /** Promote to Owner, demote an Owner, remove an Owner. */
  'owners.manage',
  /** Rename the organization. */
  'org.rename',
  /** Transfer ownership of the organization to another member. */
  'org.transfer',
  /** Delete the organization. */
  'org.delete',
  /** Payment methods, the Stripe portal, and subscription activation. */
  'billing.manage',
  /** Usage and invoices. */
  'billing.view',
  /** List buckets and read bucket configuration. */
  'buckets.read',
  /** Create a bucket. */
  'buckets.create',
  /** Delete a bucket. */
  'buckets.delete',
  /** View, download, and mint read presigns for objects. */
  'objects.read',
  /** Upload objects (console and presign). */
  'objects.write',
  /** Delete objects (console and presign). */
  'objects.delete',
  /** Mint a new access key or RAG key. */
  'keys.create',
  /** List and revoke keys the caller created. */
  'keys.manage_own',
  /** List and revoke every key in the org. */
  'keys.manage_all',
  /** Read the org's audit log. */
  'audit.view',
  /**
   * Download the org's audit log as a CSV.
   *
   * Separate from reading it because it is a different act: exporting takes the
   * history out of the system, where nothing FilOne runs can see what happens
   * to it next. The two are granted to the same roles today, and the split is
   * what lets that change without touching a handler.
   */
  'audit.export',
  /**
   * Manage privileged-operation grants — the M2 grant-management authority.
   * Holding it confers no privileged operation; it is the right to grant one to
   * a member. Reading retention state is an ordinary `objects.read`.
   */
  'privileged.grant',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The capability matrix. Owner is a superset of Admin, Admin of Member, and
 * Member of ReadOnly, but the sets are written out rather than derived: the
 * matrix is a product decision, and a spread chain would make an intended
 * exception look like a bug.
 *
 * Typed as `Record<OrgRole, readonly Permission[]>` rather than as its literal
 * shape so a consumer can ask `.includes(permission)` of any row, and frozen so
 * the table a caller reads is the table this file declares.
 */
export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = Object.freeze({
  [OrgRole.Owner]: Object.freeze([
    'members.read',
    'members.manage',
    'owners.manage',
    'org.rename',
    'org.transfer',
    'org.delete',
    'billing.manage',
    'billing.view',
    'buckets.read',
    'buckets.create',
    'buckets.delete',
    'objects.read',
    'objects.write',
    'objects.delete',
    'keys.create',
    'keys.manage_own',
    'keys.manage_all',
    'audit.view',
    'audit.export',
    'privileged.grant',
  ] as const),
  [OrgRole.Admin]: Object.freeze([
    'members.read',
    'members.manage',
    'org.rename',
    'billing.view',
    'buckets.read',
    'buckets.create',
    'buckets.delete',
    'objects.read',
    'objects.write',
    'objects.delete',
    'keys.create',
    'keys.manage_own',
    'keys.manage_all',
    'audit.view',
    'audit.export',
  ] as const),
  [OrgRole.Member]: Object.freeze([
    'members.read',
    'buckets.read',
    'buckets.create',
    'objects.read',
    'objects.write',
    'objects.delete',
    'keys.create',
    'keys.manage_own',
  ] as const),
  [OrgRole.ReadOnly]: Object.freeze(['members.read', 'buckets.read', 'objects.read'] as const),
});

/** The permission set of anything that is not one of the four roles. */
const NO_PERMISSIONS: readonly Permission[] = Object.freeze([]);

/**
 * Role ordering, highest authority first, for presenting roles in a stable
 * order and for asserting that the matrix nests. No authorization check reads
 * it: the target ceiling below is expressed in permissions, not in rank, so
 * that "who may touch an Owner" stays a matrix question.
 */
export const ROLE_RANK = {
  [OrgRole.Owner]: 3,
  [OrgRole.Admin]: 2,
  [OrgRole.Member]: 1,
  [OrgRole.ReadOnly]: 0,
} as const satisfies Record<OrgRole, number>;

/**
 * The permissions a role holds, or an empty list for a value that is not one of
 * the four roles — a membership row carrying an unknown role grants nothing.
 *
 * The parameter is `string` because every caller is holding a value read out of
 * DynamoDB: taking the raw value keeps the fail-closed branch reachable instead
 * of casting past it. The own-property check is what keeps an inherited key such
 * as `'constructor'` from resolving to something that is not a permission list —
 * `Object.hasOwn` semantics, spelled the ES2020 way because the console
 * compiles this file at that target.
 */
export function permissionsForRole(role: string): readonly Permission[] {
  return isOrgRole(role) && Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role)
    ? ROLE_PERMISSIONS[role]
    : NO_PERMISSIONS;
}

/** Whether a role holds a permission. Unknown roles hold none. */
export function roleHasPermission(role: string, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

/**
 * The target ceiling: `members.manage` reaches Admin and below, and every verb
 * against an Owner — promote to, demote from, remove — routes through
 * `owners.manage`. Removal counts, otherwise deleting an Owner would reach what
 * demoting one forbids.
 *
 * This is the ceiling for a single role: the target's current role when
 * removing a member, the requested role when inviting. A role change clears the
 * ceiling on both roles, which is {@link canChangeRole}.
 *
 * A target role that is not one of the four is unmanageable rather than
 * ordinary — otherwise a mis-cased `'Owner'`, or anything else a bad write left
 * in the column, would miss the Owner branch and be managed under
 * `members.manage`.
 */
export function canManageTargetRole(actorRole: string, targetRole: string): boolean {
  if (!isOrgRole(targetRole)) return false;
  return targetRole === OrgRole.Owner
    ? roleHasPermission(actorRole, 'owners.manage')
    : roleHasPermission(actorRole, 'members.manage');
}

/**
 * Whether an actor may move a member from one role to another. A role change is
 * two reaches — at the member as they are and at the member as they would be —
 * so both must clear the ceiling: an Admin can neither demote an Owner nor
 * promote anyone to Owner.
 */
export function canChangeRole(actorRole: string, fromRole: string, toRole: string): boolean {
  return canManageTargetRole(actorRole, fromRole) && canManageTargetRole(actorRole, toRole);
}
