import { GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { OrgRole, isOrgRole, permissionsForRole } from '@filone/shared';
import type { Permission } from '@filone/shared';
import { getDynamoClient } from './ddb-client.js';

/**
 * Organization membership and invitations, in OrgTable.
 *
 * Four row shapes, all pk/sk (the table has no GSIs, like every other table
 * here), plus one key reserved for SSO:
 * - `ORG#{orgId}` / `MEMBER#{userId}` — the authoritative membership: role,
 *   when and how the member joined.
 * - `USER#{userId}` / `MEMBERSHIP#{orgId}` — the inverse item that answers
 *   "which orgs does this user belong to" without an index, the same idiom as
 *   `RAGKEYHASH#…/LOOKUP`. Written in the same transaction as the canonical
 *   row on create, delete, and every role change, so the two can never
 *   disagree about a role.
 * - `ORG#{orgId}` / `INVITE#{inviteId}` — the canonical invitation.
 * - `INVITETOKEN#{sha256(token)}` / `LOOKUP` — resolves an accept link to its
 *   invitation. The row keeps the token's hash, never the token.
 *
 * The org profile row stays in UserInfoTable (`ORG#{orgId}/PROFILE`), so the
 * transactions that change the set of Owners span both tables.
 */
export const OrgKeys = {
  orgPk: (orgId: string): string => `ORG#${orgId}`,
  memberSk: (userId: string): string => `MEMBER#${userId}`,
  memberSkPrefix: (): string => 'MEMBER#',
  userPk: (userId: string): string => `USER#${userId}`,
  membershipSk: (orgId: string): string => `MEMBERSHIP#${orgId}`,
  membershipSkPrefix: (): string => 'MEMBERSHIP#',
  /**
   * Inverse of {@link membershipSk}. Org ids are UUIDs and contain no `#`, so
   * the split is unambiguous; returns undefined for any other shape. The
   * inverse item stores no `orgId` attribute — the sort key is the org id.
   */
  parseMembershipSk: (sk: string): string | undefined => {
    const orgId = sk.startsWith('MEMBERSHIP#') ? sk.slice('MEMBERSHIP#'.length) : undefined;
    return orgId && !orgId.includes('#') ? orgId : undefined;
  },
  inviteSk: (inviteId: string): string => `INVITE#${inviteId}`,
  inviteSkPrefix: (): string => 'INVITE#',
  inviteTokenPk: (tokenHash: string): string => `INVITETOKEN#${tokenHash}`,
  inviteTokenSk: (): string => 'LOOKUP',
  /**
   * Reserved for SSO: an Auth0 organization id resolves to the FilOne org it
   * was created for. Nothing writes this row in M1 — reserving the key now
   * means adopting Auth0 Organizations changes no schema.
   */
  auth0OrgPk: (auth0OrgId: string): string => `AUTH0ORG#${auth0OrgId}`,
  auth0OrgSk: (): string => 'LOOKUP',
} as const;

/** How a member came to be in the org. SCIM provisioning extends this later. */
export type OrgMembershipSource = 'signup' | 'conversion' | 'invitation';

/** OrgTable — pk: ORG#{orgId}, sk: MEMBER#{userId} (unmarshalled shape). */
export interface OrgMemberRecord {
  orgId: string;
  userId: string;
  role: OrgRole;
  joinedAt: string;
  source: OrgMembershipSource;
  /** The member who issued the invitation, when `source` is `invitation`. */
  invitedBy?: string;
}

/** OrgTable — pk: USER#{userId}, sk: MEMBERSHIP#{orgId} (unmarshalled shape). */
export interface OrgMembershipRecord {
  orgId: string;
  role: OrgRole;
  joinedAt: string;
}

/**
 * A resolved membership, as exposed on `userInfo.membership`. It is the
 * `MEMBER#` row itself rather than a flattened permission list: member bucket
 * scope lands on this row, and its consumers then read it with no new plumbing.
 * The row's own fields are optional here because the transition fallback below
 * resolves a membership no row supplied.
 */
export interface OrgMembership extends Partial<OrgMemberRecord> {
  orgId: string;
  userId: string;
  role: OrgRole;
}

/**
 * The caller's membership in an org, or the Owner fallback below.
 *
 * TRANSITION — remove with the conversion. Accounts created before membership
 * moved into OrgTable have no row here, and some early identities never had one
 * at all. Every such account is an org of one, so resolving an absent row as
 * Owner preserves exactly today's authority. The conversion backfills the rows;
 * once its zero-count scan is verified, this fallback is deleted and an absent
 * row becomes a denial.
 */
export async function resolveMembership(
  orgId: string,
  userId: string,
  opts?: { consistentRead?: boolean },
): Promise<OrgMembership> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.OrgTable.name,
      Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.memberSk(userId) } },
      ...(opts?.consistentRead ? { ConsistentRead: true } : {}),
    }),
  );

  if (!Item) {
    return { orgId, userId, role: OrgRole.Owner };
  }

  const storedRole = Item.role?.S ?? '';
  if (!isOrgRole(storedRole)) {
    // Kept as stored rather than coerced: an unrecognized role carries no
    // permissions, so it fails closed. Log it — the only way one gets here is
    // a bad write or a conversion that missed a value.
    console.error('[org-membership] Membership row carries an unrecognized role', {
      orgId,
      userId,
    });
  }

  return {
    orgId,
    userId,
    role: storedRole as OrgRole,
    ...(Item.joinedAt?.S ? { joinedAt: Item.joinedAt.S } : {}),
    ...(Item.source?.S ? { source: Item.source.S as OrgMembershipSource } : {}),
    ...(Item.invitedBy?.S ? { invitedBy: Item.invitedBy.S } : {}),
  };
}

/** The permissions a resolved membership carries. */
export function membershipPermissions(membership: OrgMembership): readonly Permission[] {
  return permissionsForRole(membership.role);
}

/**
 * Every org the user belongs to, from the inverse items. One Query, no index.
 * Rows whose sort key is not a well-formed `MEMBERSHIP#{orgId}` are skipped
 * rather than surfaced as an org with an empty id.
 */
export async function listMemberships(userId: string): Promise<OrgMembershipRecord[]> {
  const { Items } = await getDynamoClient().send(
    new QueryCommand({
      TableName: Resource.OrgTable.name,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: OrgKeys.userPk(userId) },
        ':skPrefix': { S: OrgKeys.membershipSkPrefix() },
      },
    }),
  );

  return (Items ?? []).flatMap((item) => {
    const orgId = OrgKeys.parseMembershipSk(item.sk?.S ?? '');
    if (!orgId) return [];
    return [
      {
        orgId,
        role: (item.role?.S ?? '') as OrgRole,
        joinedAt: item.joinedAt?.S ?? '',
      },
    ];
  });
}

/**
 * TRANSITION — the account-deletion stack's role gate, re-read from OrgTable.
 * The UserInfoTable `MEMBER#` row it used to read stops existing when the
 * conversion moves membership here, so the gate resolves through the same
 * fallback as every other membership read. Deletion authority is `org.delete`,
 * which keeps the answer tied to the matrix instead of a role comparison.
 * The consistent read is deliberate: this authorizes destroying the org, so a
 * just-revoked role must not pass on a stale replica. Folded into
 * `authorize('org.delete')` when enforcement lands.
 */
export async function isOrgAdmin(orgId: string, userId: string): Promise<boolean> {
  const membership = await resolveMembership(orgId, userId, { consistentRead: true });
  return membershipPermissions(membership).includes('org.delete');
}
