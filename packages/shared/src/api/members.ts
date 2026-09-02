import { z } from 'zod';
import { OrgRole } from './org.js';
import { InvitedRoleSchema } from './invitations.js';
import type { OrgMembershipSource } from './org.js';
import type { S3Region } from '../constants.js';
import type { AccessKeyRevocationReason } from '../access-key-permissions.js';

/**
 * Member management: the org's roster, the role each member holds, removal, and
 * the one operation that moves the Owner seat.
 *
 * Every verb here is bounded by the caller's ceiling on the TARGET
 * (`canManageTargetRole`): an Admin reaches Admin and below, and any verb
 * against an Owner — promote to, demote from, remove — is `owners.manage`. The
 * schemas below carry none of that; they only keep values that are not roles or
 * not ids out of a stored row.
 */

/**
 * One member as the console lists them.
 *
 * `email` and `name` are optional and usually absent, which is worth stating
 * plainly: a user's display identity lives in Auth0, and the only rows we hold
 * for a user (`USER#{userId}/PROFILE`) carry their `sub`, their org, and when
 * they were created. The fields are here because the list is where an operator
 * expects to recognize people, and they are filled in whenever the profile row
 * has learned that much.
 */
export interface MemberSummary {
  userId: string;
  role: OrgRole;
  joinedAt?: string;
  /** How they arrived: `signup`, `conversion`, or `invitation`. */
  source?: OrgMembershipSource;
  /** Who invited them, when `source` is `invitation`. */
  invitedBy?: string;
  email?: string;
  name?: string;
}

export interface ListMembersResponse {
  members: MemberSummary[];
}

/**
 * One access key as the console lists it around a membership change. Named
 * for the key rather than its fate because the same shape serves three states:
 * the preview's forecast of what a change would revoke, what a change did
 * revoke, and a key a vendor refused to revoke.
 *
 * The id suffix rather than the whole access key id: the console shows four
 * characters, and a full `AKIA…` in a response body is a credential half nobody
 * needs to recognize a key by.
 */
export interface AccessKeySummary {
  /** The orchestrator's id for the key, which is what the row is addressed by. */
  id: string;
  keyName: string;
  /** The characters of the access key id the console already shows. */
  accessKeyIdSuffix?: string;
  region: S3Region;
  createdAt: string;
  /** Why it goes, when it does. */
  reason: AccessKeyRevocationReason;
  /** The permissions above the new role, named, when that is what condemned it. */
  excess: string[];
}

/** `PATCH /api/org/members/{userId}` — move one member to another role. */
export const UpdateMemberRoleSchema = z.object({ role: InvitedRoleSchema });

export type UpdateMemberRoleRequest = z.infer<typeof UpdateMemberRoleSchema>;

export interface UpdateMemberRoleResponse {
  userId: string;
  role: OrgRole;
  /** The role they held before, so the console can narrate what changed. */
  previousRole: OrgRole;
  /**
   * The access keys the change revoked, which is what happened rather than what
   * the preview offered: the commit revokes from a fresh read, so this can name
   * a key minted since the preview and omit one revoked since.
   */
  revokedKeys?: RevokedKeySummary[];
  /**
   * A key the storage vendor refused to delete after the role was already
   * written. The role change stands and the credential is still live, and this
   * request will not try again: asking for the role the member now holds does
   * nothing. Somebody holding `keys.manage_all` has to revoke it.
   */
  failedKeys?: RevokedKeySummary[];
}

/**
 * A role change that stopped partway.
 *
 * The keys named in `revokedKeys` are gone whatever the role now says, so the
 * console reports them rather than treating the whole request as a no-op. The
 * retry is the same PATCH, which finds fewer keys.
 */
export interface UpdateMemberRoleFailure {
  message: string;
  revokedKeys: RevokedKeySummary[];
  /** The key a vendor refused, when that is what stopped the change. */
  failedKey?: RevokedKeySummary;
}

/**
 * `GET /api/org/members/{userId}/role-change-preview?role=` — what a role
 * change would take away, before it happens.
 *
 * The admin sees the keys before confirming. What the change actually revoked
 * comes back on the PATCH, and may differ: the commit revokes from a fresh
 * read, so a key minted since the preview is included and a key revoked since
 * is not.
 */
export interface RoleChangePreviewResponse {
  /** The target's current role, so the dialog can name the move. */
  currentRole: OrgRole;
  role: OrgRole;
  keys: AccessKeySummary[];
  /** The target's keys that stay live. */
  retainedKeyCount: number;
  /**
   * Keys in this org with no recorded owner, which no role change touches.
   * Shown beside the list so a short list is not read as the whole story.
   */
  unattributedKeyCount: number;
}

/**
 * `POST /api/org/transfer` — hand the Owner seat to another member.
 *
 * A member id rather than an email: the target is already in the org, so the
 * console picks them from the list it just rendered, and an email would add a
 * lookup that can resolve to somebody who is not a member.
 */
export const TransferOwnershipSchema = z.object({
  userId: z.string().trim().min(1, 'Choose the member to transfer ownership to.'),
});

export type TransferOwnershipRequest = z.infer<typeof TransferOwnershipSchema>;

export interface TransferOwnershipResponse {
  /** The new Owner. */
  userId: string;
  /** The caller, now an Admin — the org keeps exactly one Owner. */
  previousOwnerUserId: string;
}
