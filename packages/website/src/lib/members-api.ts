import type {
  AcceptInvitationResponse,
  CreateInvitationRequest,
  CreateInvitationResponse,
  ListInvitationsResponse,
  ListMembersResponse,
  OrgRole,
  RemoveMemberResponse,
  RoleChangePreviewResponse,
  TransferOwnershipResponse,
  UpdateMemberRoleResponse,
} from '@filone/shared';

import { apiRequest, StepUpRequiredError } from './api.js';
import { redirectToStepUp } from './step-up.js';

/**
 * The org's roster and the invitations that fill it.
 *
 * Its own module, like the RAG clients beside it, because the members console is
 * the only surface that calls any of it — and because `transferOwnership` below
 * carries a step-up round trip that no other org call needs.
 */

export function listMembers(): Promise<ListMembersResponse> {
  return apiRequest<ListMembersResponse>('/org/members');
}

/**
 * Move one member to another role.
 *
 * The response says what they held before as well as what they hold now, so the
 * console can narrate the change rather than assert the new state.
 */
export function updateMemberRole(userId: string, role: OrgRole): Promise<UpdateMemberRoleResponse> {
  return apiRequest<UpdateMemberRoleResponse>(`/org/members/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

/**
 * What a role change would revoke, before it happens.
 *
 * A key carries its own permission set, fixed when it was minted, so a member
 * moving to a narrower role keeps whatever their keys already hold until the
 * change takes them away. This is the list, so the admin confirms a change they
 * can see the consequences of.
 */
export function getRoleChangePreview(
  userId: string,
  role: OrgRole,
): Promise<RoleChangePreviewResponse> {
  return apiRequest<RoleChangePreviewResponse>(
    `/org/members/${encodeURIComponent(userId)}/role-change-preview?role=${encodeURIComponent(role)}`,
  );
}

/**
 * Remove a member from the org.
 */
export function removeMember(userId: string): Promise<RemoveMemberResponse> {
  return apiRequest<RemoveMemberResponse>(`/org/members/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

export function listInvitations(): Promise<ListInvitationsResponse> {
  return apiRequest<ListInvitationsResponse>('/org/invitations');
}

/**
 * Invite an address at or below the caller's ceiling.
 *
 * `emailSent: false` in the answer is a success nobody was told about: the row
 * and its token are committed before SendGrid is called. Re-inviting the same
 * address is the retry — it replaces the live invitation rather than adding a
 * second one — because the token exists only in the email and there is no link
 * for the console to hand over.
 */
export function createInvitation(body: CreateInvitationRequest): Promise<CreateInvitationResponse> {
  return apiRequest<CreateInvitationResponse>('/org/invitations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function revokeInvitation(inviteId: string): Promise<void> {
  return apiRequest<void>(`/org/invitations/${encodeURIComponent(inviteId)}`, {
    method: 'DELETE',
  });
}

/**
 * Redeem an invitation token.
 *
 * Not gated on membership — the caller is by definition not a member yet — but
 * gated on the session's verified email matching the address invited, which
 * arrives as `INVITE_EMAIL_MISMATCH`.
 *
 * The only call that opts out of both pieces of app-wide plumbing. The org
 * header would name an org this caller is not in, which the server can only
 * refuse it for once org SSO ships; and the unverified-email redirect would
 * navigate away from a page that has a better answer for that refusal, with the
 * invitation still named.
 */
export function acceptInvitation(token: string): Promise<AcceptInvitationResponse> {
  return apiRequest<AcceptInvitationResponse>(
    '/invitations/accept',
    { method: 'POST', body: JSON.stringify({ token }) },
    { omitOrgHeader: true, rendersUnverifiedEmail: true },
  );
}

/**
 * Hand the Owner seat to another member.
 *
 * The one org call behind a step-up, so it carries the same catch as
 * `deletePasskey`: a fresh-authentication redirect leaves the page, and the
 * promise is held rather than rejected so nothing renders an error over a page
 * that is disappearing. The step-up stash brings the caller back to this page
 * with `?action=transfer-ownership`.
 */
export async function transferOwnership(
  userId: string,
  options: { stepUpAction?: string } = {},
): Promise<TransferOwnershipResponse> {
  try {
    return await apiRequest<TransferOwnershipResponse>('/org/transfer', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  } catch (err) {
    if (err instanceof StepUpRequiredError) {
      redirectToStepUp(options.stepUpAction ?? 'transfer-ownership');
      return new Promise<TransferOwnershipResponse>(() => {});
    }
    throw err;
  }
}
