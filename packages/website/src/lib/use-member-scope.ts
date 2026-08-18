import { canChangeRole, canManageTargetRole, OrgRole } from '@filone/shared';

import { usePermissions } from './use-permissions.js';

/**
 * Roles highest authority first — the order an operator reads them in, and the
 * order every role list in the console renders. It matches `ROLE_RANK` in the
 * shared registry, which is where the ordering is decided.
 */
export const ROLES_BY_AUTHORITY: readonly OrgRole[] = Object.freeze([
  OrgRole.Owner,
  OrgRole.Admin,
  OrgRole.Member,
  OrgRole.ReadOnly,
]);

/** What each role is called where a person reads it. */
export const ROLE_LABELS: Record<OrgRole, string> = Object.freeze({
  [OrgRole.Owner]: 'Owner',
  [OrgRole.Admin]: 'Admin',
  [OrgRole.Member]: 'Member',
  [OrgRole.ReadOnly]: 'Read only',
});

/** One line on what each role can do, for the role picker. */
export const ROLE_DESCRIPTIONS: Record<OrgRole, string> = Object.freeze({
  [OrgRole.Owner]: 'Everything, including billing and ownership of the organization.',
  [OrgRole.Admin]: 'Manage members, buckets, and keys. Cannot change billing or owners.',
  [OrgRole.Member]: 'Read and write objects, create buckets, and mint their own keys.',
  [OrgRole.ReadOnly]: 'Read buckets and objects. Changes nothing.',
});

export function roleLabel(role: string): string {
  return role in ROLE_LABELS ? ROLE_LABELS[role as OrgRole] : role;
}

/**
 * Who the caller may act on, and which roles they may hand out.
 *
 * The same shape as `useKeyActionScope`: the server enforces a ceiling, and the
 * console mirrors it so a member is not offered a control that returns a 403.
 * The predicates are the shared ones — `canManageTargetRole` and
 * `canChangeRole` — asked with the caller's own role, so the console and the
 * handler answer from one table. Reproducing the rule in permission terms would
 * work today and drift the first time the matrix moves.
 *
 * Everything fails closed while `/me` is in flight: `role` is undefined then,
 * and an undefined role holds no permissions.
 */
export function useMemberActionScope(): {
  /** The caller's own user id, for the rows that are about them. */
  userId: string | undefined;
  /** The caller's role, for copy that names it. */
  role: OrgRole | undefined;
  /** Whether the caller may manage members at all. */
  mayManage: boolean;
  /** Whether the caller may see and issue invitations. */
  mayInvite: boolean;
  /** Whether the caller may transfer the Owner seat. */
  mayTransfer: boolean;
  /** Whether the caller may remove a member holding this role. */
  mayManageTarget: (targetRole: string) => boolean;
  /** Whether the caller may move a member from one role to another. */
  mayChangeRole: (fromRole: string, toRole: string) => boolean;
  /**
   * The roles the caller may put somebody into — the ceiling as a list, for a
   * role picker. An Admin gets Admin and below; an Owner gets all four.
   */
  assignableRoles: readonly OrgRole[];
} {
  const { has, userId, role } = usePermissions();

  // An absent role is not one of the four, so every shared predicate below
  // refuses it. Spelled as the empty string rather than coerced, because the
  // predicates take the raw stored value on purpose.
  const actorRole = role ?? '';

  return {
    userId,
    role,
    mayManage: has('members.manage'),
    mayInvite: has('members.manage'),
    mayTransfer: has('org.transfer'),
    mayManageTarget: (targetRole: string) => canManageTargetRole(actorRole, targetRole),
    mayChangeRole: (fromRole: string, toRole: string) => canChangeRole(actorRole, fromRole, toRole),
    assignableRoles: ROLES_BY_AUTHORITY.filter((candidate) =>
      canManageTargetRole(actorRole, candidate),
    ),
  };
}
