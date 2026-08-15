import { OrgRole } from './api/org.js';

/**
 * The console permission registry: the vocabulary every authorization check
 * speaks, plus the fixed role → permission table behind it.
 *
 * Four roles and a closed permission set need no policy engine, so this is
 * plain data — a string-literal union and an `as const` table — read by the
 * backend's `authorize()` middleware and shipped to the console on
 * `MeResponse.permissions` so the UI hides what the server would refuse.
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
  /** Read the org's audit log (viewer ships in M2). */
  'audit.view',
  /** Grant privileged operations such as retention and legal hold (M2). */
  'privileged.grant',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The capability matrix. Owner is a superset of Admin, Admin of Member, and
 * Member of ReadOnly, but the sets are written out rather than derived: the
 * matrix is a product decision, and a spread chain would make an intended
 * exception look like a bug.
 */
export const ROLE_PERMISSIONS = {
  [OrgRole.Owner]: [
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
    'privileged.grant',
  ],
  [OrgRole.Admin]: [
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
  ],
  [OrgRole.Member]: [
    'members.read',
    'buckets.read',
    'buckets.create',
    'objects.read',
    'objects.write',
    'objects.delete',
    'keys.create',
    'keys.manage_own',
  ],
  [OrgRole.ReadOnly]: ['members.read', 'buckets.read', 'objects.read'],
} as const satisfies Record<OrgRole, readonly Permission[]>;

/**
 * Role ordering, highest authority first. Used for the target ceiling below and
 * for presenting roles in a stable order; it is not itself an authorization
 * check — {@link ROLE_PERMISSIONS} is.
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
 */
export function permissionsForRole(role: OrgRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

/** Whether a role holds a permission. Unknown roles hold none. */
export function roleHasPermission(role: OrgRole, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

/**
 * The target ceiling: `members.manage` reaches Admin and below, and every verb
 * against an Owner — promote to, demote from, remove — routes through
 * `owners.manage`. Removal counts, otherwise deleting an Owner would reach what
 * demoting one forbids.
 *
 * Applies to the target's current role when changing or removing a member, and
 * to the requested role when inviting or promoting; a role change must clear
 * both.
 */
export function canManageTargetRole(actorRole: OrgRole, targetRole: OrgRole): boolean {
  return targetRole === OrgRole.Owner
    ? roleHasPermission(actorRole, 'owners.manage')
    : roleHasPermission(actorRole, 'members.manage');
}
