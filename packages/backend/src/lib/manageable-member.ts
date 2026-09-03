import { canChangeRole, canManageTargetRole } from '@filone/shared';
import type { OrgRole } from '@filone/shared';
import { resolveMembership } from './org-membership.js';
import type { OrgMembership } from './org-membership.js';
import {
  badRequestResponse,
  beyondCeilingResponse,
  notAMemberResponse,
} from './response-builder.js';
import { proceed, refuse } from './result.js';
import type { Result } from './result.js';
import { getUserInfo } from './user-context.js';
import type { AuthenticatedEvent } from './user-context.js';

/**
 * What the caller means to do to the member.
 *
 * It decides two things together, which is why it is one value rather than a
 * predicate and a phrase passed side by side: which ceiling applies, and how
 * the refusal names what was refused. A role change is bounded by the role
 * asked for as well as the one held; a removal only by the one held.
 */
export type MemberVerb = { kind: 'role-change'; toRole: OrgRole } | { kind: 'removal' };

/**
 * The preflight every verb against another member opens with: the path names
 * somebody, that somebody is in the org, and the caller's role reaches theirs.
 *
 * Each failure is its own refusal, in that order, so the 403 never describes a
 * role that was never read.
 *
 * Returns the target alone. The caller's role is what the ceiling was asked
 * about and no handler reads it afterwards, so handing it back would be a field
 * nobody uses.
 */
export async function requireManageableMember(
  event: AuthenticatedEvent,
  verb: MemberVerb,
): Promise<Result<OrgMembership>> {
  const targetUserId = event.pathParameters?.userId;
  if (!targetUserId) return refuse(badRequestResponse('Missing userId in path'));

  const { orgId, membership } = getUserInfo(event);
  const target = await resolveMembership(orgId, targetUserId);
  if (!target) return refuse(notAMemberResponse());

  // `authorize('members.manage')` refused every caller without a membership row.
  const actorRole = membership!.role;
  const reaches =
    verb.kind === 'role-change'
      ? canChangeRole(actorRole, target.role, verb.toRole)
      : canManageTargetRole(actorRole, target.role);

  if (!reaches) return refuse(beyondCeilingResponse(refusedVerb(verb, target.role)));

  return proceed(target);
}

/** Fills `Your role in this organization cannot ___.` */
function refusedVerb(verb: MemberVerb, targetRole: OrgRole): string {
  return verb.kind === 'role-change'
    ? `change a ${targetRole} to ${verb.toRole}`
    : `remove a ${targetRole}`;
}
