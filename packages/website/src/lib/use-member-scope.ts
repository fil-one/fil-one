import { canChangeRole, canManageTargetRole, OrgRole } from '@filone/shared';
import type { MemberSummary } from '@filone/shared';

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
 * How a member is named wherever the console names one — the row, the dialog
 * about that row, and the toast that follows it.
 *
 * A user's display identity lives in Auth0; the membership row carries an id, a
 * role, and when they joined, so `name` and `email` are usually absent today.
 * One helper rather than one per surface, because the whole point of a dialog's
 * sentence is that it is about the row behind it. The row prints the id under
 * the name, which is what an operator quotes to support, so the fallback here
 * does not have to.
 */
export function memberName(member: Pick<MemberSummary, 'name' | 'email'>): string {
  return member.name || member.email || 'Unnamed member';
}

/**
 * Whether the Owner seat can be handed to this member.
 *
 * Asked in two places — the row that offers the button, and the step-up resume
 * that reopens the dialog after a trip through Auth0 — which have to agree: a
 * resume is a second chance at the same action, and the caller's own role may
 * have changed while they were away. The server enforces it either way; this
 * keeps a refusal off the screen.
 */
export function canTransferTo(
  member: Pick<MemberSummary, 'role' | 'userId'>,
  scope: { mayTransfer: boolean; currentUserId?: string },
): boolean {
  return (
    scope.mayTransfer && member.role !== OrgRole.Owner && member.userId !== scope.currentUserId
  );
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
  /**
   * Whether the caller may see and issue invitations — `members.manage` and an
   * org in the beta, which is what `POST /api/org/invitations` asks.
   *
   * The permission alone is not the question. A caller who belongs to more than
   * one org reaches the members page in every one of them, so an Owner of a
   * personal org outside the beta would otherwise be offered a form whose only
   * possible answer is a 403.
   */
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
  const { has, userId, role, orgsBeta } = usePermissions();

  // An absent role is not one of the four, so every shared predicate below
  // refuses it. Spelled as the empty string rather than coerced, because the
  // predicates take the raw stored value on purpose.
  const actorRole = role ?? '';

  return {
    userId,
    role,
    mayManage: has('members.manage'),
    mayInvite: has('members.manage') && orgsBeta,
    mayTransfer: has('org.transfer'),
    mayManageTarget: (targetRole: string) => canManageTargetRole(actorRole, targetRole),
    mayChangeRole: (fromRole: string, toRole: string) => canChangeRole(actorRole, fromRole, toRole),
    assignableRoles: ROLES_BY_AUTHORITY.filter((candidate) =>
      canManageTargetRole(actorRole, candidate),
    ),
  };
}
