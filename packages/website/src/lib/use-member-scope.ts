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
  [OrgRole.Owner]:
    'This user will be able to do everything, including billing and owning the organization.',
  [OrgRole.Admin]:
    'This user will be able to manage members, buckets, and keys, but not billing or owners.',
  [OrgRole.Member]:
    'This user will be able to read and write objects, and create buckets and their own keys.',
  [OrgRole.ReadOnly]: "This user will be able to read buckets and objects, but can't make changes.",
});

/**
 * The same capabilities as `ROLE_DESCRIPTIONS`, addressed to the person holding
 * the role rather than to whoever is handing it out — the accept page tells a
 * new member what they can do, not what somebody else will be able to do.
 *
 * Verb phrases rather than sentences, so the accept page can set them after the
 * role badge without a full stop landing against it. Only what the role grants,
 * with none of the "but not X" the granting-side copy carries: this is the
 * first screen of somebody's membership, and the limits are worth stating to
 * whoever picks a role, not to whoever receives it.
 */
export const ROLE_CAPABILITIES_SELF: Record<OrgRole, string> = Object.freeze({
  [OrgRole.Owner]: 'do everything here, including billing and owning the organization',
  [OrgRole.Admin]: 'manage members, buckets, and keys',
  [OrgRole.Member]: 'read and write objects, create buckets, and mint your own keys',
  [OrgRole.ReadOnly]: 'browse buckets and read objects',
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
   * Whether the caller may see and issue invitations — `members.manage`, which
   * is what `POST /api/org/invitations` asks.
   *
   * This was once also gated on the organizations beta (`orgsBeta`): the invite
   * endpoint refused any org outside it, so the form was withheld to keep a
   * guaranteed 403 off the screen. Invitations are generally available now, so
   * the permission alone is the question again.
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
