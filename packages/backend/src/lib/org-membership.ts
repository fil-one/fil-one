import { GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { OrgRole, isOrgRole } from '@filone/shared';
import type { OrgMembershipSource, OrgMembershipSummary } from '@filone/shared';
import { getDynamoClient } from './ddb-client.js';
import { resolveOrgName } from './org-profile.js';

/**
 * Organization membership, in OrgTable.
 *
 * Three row shapes, all pk/sk (the table has no GSIs, like every other table
 * here), plus one key reserved for SSO:
 * - `ORG#{orgId}` / `MEMBER#{userId}` — the authoritative membership: role,
 *   when and how the member joined.
 * - `USER#{userId}` / `MEMBERSHIP#{orgId}` — the inverse item that answers
 *   "which orgs does this user belong to" without an index, the same idiom as
 *   `RAGKEYHASH#…/LOOKUP`. Written in the same transaction as the canonical
 *   row on create, delete, and every role change, so the two can never
 *   disagree about a role.
 * - `ORG#{orgId}` / `META` — org-level counters owned by this module, starting
 *   with `ownerCount`, the last-Owner invariant. It sits beside the rows it
 *   counts so every owner-set transaction is single-table.
 *
 * Two more shapes belong to invitations, and their key builders are here beside
 * the membership ones because an accept transaction writes both families at
 * once:
 * - `ORG#{orgId}` / `INVITE#{inviteId}` — the canonical invitation.
 * - `INVITETOKEN#{sha256(token)}` / `LOOKUP` — the inverse item that resolves an
 *   accept link, written and deleted in the same transaction as the row it
 *   points at. Only the hash is ever stored; the token itself exists in the
 *   email and nowhere else. The lifecycle lives in `lib/invitations.ts`.
 * - `ORG#{orgId}` / `INVITEADDR#{emailNorm}` — the one item every invitation to
 *   an address writes, so two of them cannot both land. It names the invitation
 *   that currently holds the address and nothing else.
 *
 * The org profile row stays in UserInfoTable (`ORG#{orgId}/PROFILE`), so the
 * transactions that change an org's name and its membership span both tables.
 */

/** The canonical membership sort-key prefix, shared by the builder and the parser. */
const memberSkPrefix = (): string => 'MEMBER#';

/** The inverse item's sort-key prefix, shared by the builder and the parser. */
const membershipSkPrefix = (): string => 'MEMBERSHIP#';

/** The invitation sort-key prefix, shared by the builder and the parser. */
const inviteSkPrefix = (): string => 'INVITE#';

/**
 * The address-claim sort-key prefix. Deliberately not under
 * {@link inviteSkPrefix}: the invitation Query is `begins_with(sk, 'INVITE#')`,
 * and a claim row swept into that list would be read as an invitation whose
 * every field is missing.
 */
const inviteAddrSkPrefix = (): string => 'INVITEADDR#';

export const OrgKeys = {
  orgPk: (orgId: string): string => `ORG#${orgId}`,
  memberSk: (userId: string): string => `${memberSkPrefix()}${userId}`,
  memberSkPrefix,
  /**
   * Inverse of {@link memberSk}. User ids are UUIDs, so the same no-`#` check as
   * {@link parseMembershipSk} makes the split unambiguous; returns undefined for
   * any other shape, `MEMBER#` with nothing after it included — an empty user id
   * addresses `USER#`, a partition belonging to nobody. Every reader of this key
   * shape parses it here so the census and the teardown cannot disagree about
   * what a member row is.
   */
  parseMemberSk: (sk: string | undefined): string | undefined => {
    const prefix = memberSkPrefix();
    const userId = sk?.startsWith(prefix) ? sk.slice(prefix.length) : undefined;
    return userId && !userId.includes('#') ? userId : undefined;
  },
  orgMetaSk: (): string => 'META',
  userPk: (userId: string): string => `USER#${userId}`,
  membershipSk: (orgId: string): string => `MEMBERSHIP#${orgId}`,
  membershipSkPrefix,
  /**
   * Inverse of {@link membershipSk}. Org ids are UUIDs and contain no `#`, so
   * the split is unambiguous; returns undefined for any other shape. The
   * inverse item stores no `orgId` attribute — the sort key is the org id.
   */
  parseMembershipSk: (sk: string): string | undefined => {
    const prefix = membershipSkPrefix();
    const orgId = sk.startsWith(prefix) ? sk.slice(prefix.length) : undefined;
    return orgId && !orgId.includes('#') ? orgId : undefined;
  },
  inviteSk: (inviteId: string): string => `${inviteSkPrefix()}${inviteId}`,
  inviteSkPrefix,
  /**
   * Inverse of {@link inviteSk}, for a Query that walks an org's invitations and
   * needs each row's id back. Invitation ids are UUIDs, so the same
   * no-`#` check as {@link parseMembershipSk} makes the split unambiguous.
   */
  parseInviteSk: (sk: string): string | undefined => {
    const prefix = inviteSkPrefix();
    const inviteId = sk.startsWith(prefix) ? sk.slice(prefix.length) : undefined;
    return inviteId && !inviteId.includes('#') ? inviteId : undefined;
  },
  /**
   * The address an invitation was sent to, lowercased, as a key. Built and
   * compared only — never parsed back — so an address containing `#` addresses
   * its own row rather than an ambiguous one.
   */
  inviteAddrSk: (emailNorm: string): string => `${inviteAddrSkPrefix()}${emailNorm}`,
  inviteAddrSkPrefix,
  /**
   * The token lookup, keyed by the token's SHA-256 and never by the token. The
   * hash is what arrives from an accept request, so the digest is the address:
   * there is nothing to compare and no row to scan.
   */
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

/**
 * How a member came to be in the org, defined in shared because the audit
 * envelope records the same value.
 */
export type { OrgMembershipSource };

/**
 * OrgTable — pk: ORG#{orgId}, sk: MEMBER#{userId}. The authoritative membership
 * and what `userInfo.membership` carries: the row itself rather than a
 * flattened permission list, because member bucket scope (FIL-1017) lands here
 * and its consumers then read it with no new plumbing.
 *
 * `orgId` and `userId` are derived from the key; neither is a stored attribute.
 * Everything the row records about how the member joined is optional, because a
 * membership created before those attributes existed carries none of them.
 */
export interface OrgMembership {
  orgId: string;
  userId: string;
  role: OrgRole;
  joinedAt?: string;
  source?: OrgMembershipSource;
  /** The member who issued the invitation, when `source` is `invitation`. */
  invitedBy?: string;
}

/**
 * OrgTable — pk: USER#{userId}, sk: MEMBERSHIP#{orgId}. The inverse item, whose
 * `orgId` likewise comes from the sort key.
 */
export interface OrgMembershipRecord {
  orgId: string;
  role: OrgRole;
  joinedAt: string;
}

/** OrgTable — pk: ORG#{orgId}, sk: META. Org-level counters. */
export interface OrgMetaRecord {
  /**
   * Members holding {@link OrgRole.Owner}. Every transaction that changes the
   * owner set carries its delta, and the guard against removing the last Owner
   * is that update's own condition.
   */
  ownerCount: number;
}

/**
 * A stored row minus its keys, typed as a partial of the record it belongs to.
 *
 * The whole item is decoded rather than picked attribute by attribute, so a
 * field this module does not name yet — member bucket scope is the next one —
 * reaches its consumers without a change here. The keys are dropped because
 * `pk`/`sk` are addresses, not membership data.
 */
function decodeRow<T>(item: Record<string, AttributeValue>): Partial<T> {
  const { pk: _pk, sk: _sk, ...attributes } = unmarshall(item);
  return attributes as Partial<T>;
}

/**
 * The caller's membership in an org, or undefined when no row exists.
 *
 * Absence means the caller is not a member, and `authorize` turns it into a
 * 403. This helper never guesses at one: the invite, removal, and enforcement
 * paths all read absence as denial.
 *
 * Only OrgTable is read. A pre-conversion account's `admin` row is in
 * UserInfoTable, which nothing here touches — so an unconverted account reads
 * as a non-member, which is what the conversion's verification gate is for.
 *
 * Read consistently — a membership written moments earlier (signup, an accepted
 * invitation, a role change) must not read as absent.
 */
export async function resolveMembership(
  orgId: string,
  userId: string,
): Promise<OrgMembership | undefined> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.OrgTable.name,
      Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.memberSk(userId) } },
      ConsistentRead: true,
    }),
  );

  if (!Item) return undefined;

  const attributes = decodeRow<OrgMembership>(Item);
  const storedRole = attributes.role ?? '';
  if (!isOrgRole(storedRole)) {
    // Kept as stored rather than coerced or dropped: an unrecognized role
    // carries no permissions, so it fails closed on every check, while
    // returning undefined would report a member who exists as no member at all
    // and count against the conversion's lockout metric. Log it — the only way
    // one gets here is a bad write or a conversion that missed a value.
    console.error('[org-membership] Membership row carries an unrecognized role', {
      orgId,
      userId,
      role: storedRole,
    });
  }

  return { ...attributes, orgId, userId, role: storedRole as OrgRole };
}

/**
 * The org's Owner counter, or undefined when the META row or the attribute is
 * missing.
 *
 * Read only after a transaction cancelled on that counter, to tell two very
 * different failures apart: the guard firing on an org's last Owner, and there
 * being no counter for the guard to read. The first is the invariant working;
 * the second is a conversion gap the drift checker repairs, and answering
 * "you are the last Owner" for it would diagnose an org we cannot diagnose.
 *
 * Consistent, because the transaction that just failed is the thing it is
 * explaining.
 */
export async function readOwnerCount(orgId: string): Promise<number | undefined> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.OrgTable.name,
      Key: { pk: { S: OrgKeys.orgPk(orgId) }, sk: { S: OrgKeys.orgMetaSk() } },
      ConsistentRead: true,
    }),
  );

  const stored = Item?.ownerCount?.N;
  if (stored === undefined) return undefined;
  const ownerCount = Number(stored);
  return Number.isFinite(ownerCount) ? ownerCount : undefined;
}

/**
 * The most inverse items one Query walk will collect. An org of one has a
 * single row and an invited user a handful; a user with more memberships than
 * this is a bug or an attack, and truncating names both in the log rather than
 * paging forever on the login path.
 */
const MAX_MEMBERSHIPS = 100;

/**
 * The result of one membership walk: the rows that decoded, and how many did
 * not.
 *
 * A caller that only needs somewhere to send the user reads `memberships` and
 * ignores the rest. A caller whose decision turns on the list being complete —
 * account deletion's census, which ends an account when it reads no other
 * membership — reads `undecodable` and fails closed on anything above zero.
 */
export interface MembershipListing {
  memberships: OrgMembershipRecord[];
  /** Inverse items this walk could not decode into a membership. */
  undecodable: number;
}

/**
 * The most member rows the roster read will collect. An M1 org is a handful of
 * people; a page that would need more than this is a product decision (paging,
 * search) rather than something to discover by timing out.
 */
const MAX_MEMBERS = 500;

/**
 * Every member of an org, from the canonical rows. One Query on the org's
 * partition — the access pattern the ADR chose OrgTable for — paged because a
 * Query returns at most 1 MB per call.
 *
 * A row whose sort key is not a well-formed `MEMBER#{userId}` or whose role is
 * not one of the four is dropped and logged: the roster is what the console
 * renders role controls from, and a member with a role nothing can authorize
 * would render controls that always fail.
 */
export async function listMembers(orgId: string): Promise<OrgMembership[]> {
  const members: OrgMembership[] = [];
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const { Items, LastEvaluatedKey } = await getDynamoClient().send(
      new QueryCommand({
        TableName: Resource.OrgTable.name,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': { S: OrgKeys.orgPk(orgId) },
          ':skPrefix': { S: OrgKeys.memberSkPrefix() },
        },
        // Consistent: a member added or removed moments ago must not still be
        // the list the caller acts on next.
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );

    for (const item of Items ?? []) {
      const member = toMembership(item, orgId);
      if (member) members.push(member);
    }

    if (members.length >= MAX_MEMBERS) {
      console.error('[org-membership] Member list truncated at the cap', {
        orgId,
        cap: MAX_MEMBERS,
      });
      return members.slice(0, MAX_MEMBERS);
    }

    startKey = LastEvaluatedKey;
  } while (startKey);

  return members;
}

function toMembership(
  item: Record<string, AttributeValue>,
  orgId: string,
): OrgMembership | undefined {
  const sk = item.sk?.S ?? '';
  const userId = OrgKeys.parseMemberSk(sk);
  if (!userId) {
    console.error('[org-membership] Row in the member range has no member key — dropped', {
      orgId,
      sk,
    });
    return undefined;
  }

  const attributes = decodeRow<OrgMembership>(item);
  const storedRole = attributes.role ?? '';
  if (!isOrgRole(storedRole)) {
    console.error('[org-membership] Member row carries an unrecognized role — dropped', {
      orgId,
      userId,
      role: storedRole,
    });
    return undefined;
  }

  return { ...attributes, orgId, userId, role: storedRole };
}

/**
 * Every org the user belongs to, from the inverse items. One Query, no index,
 * paged because a Query returns at most 1 MB per call.
 *
 * A row is dropped when its sort key is not a well-formed `MEMBERSHIP#{orgId}`
 * or its role is not one of the four, rather than surfaced as an org with an
 * empty id or a role nothing can authorize. Both drops are logged with the
 * offending value: the only way one gets written is a bad write or a conversion
 * that missed a value, and a silent drop hides exactly that. The count of them
 * is reported alongside the list, for the callers a dropped row would mislead.
 */
export async function listMembershipRows(userId: string): Promise<MembershipListing> {
  const memberships: OrgMembershipRecord[] = [];
  let undecodable = 0;
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const { Items, LastEvaluatedKey } = await getDynamoClient().send(
      new QueryCommand({
        TableName: Resource.OrgTable.name,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': { S: OrgKeys.userPk(userId) },
          ':skPrefix': { S: OrgKeys.membershipSkPrefix() },
        },
        // Consistent for the same reason as the membership read: an org joined
        // moments ago must appear in the list the console switches on.
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );

    for (const item of Items ?? []) {
      const record = toMembershipRecord(item, userId);
      if (record) memberships.push(record);
      else undecodable++;
    }

    if (memberships.length >= MAX_MEMBERSHIPS) {
      console.error('[org-membership] Membership list truncated at the cap', {
        userId,
        cap: MAX_MEMBERSHIPS,
      });
      return { memberships: memberships.slice(0, MAX_MEMBERSHIPS), undecodable };
    }

    startKey = LastEvaluatedKey;
  } while (startKey);

  return { memberships, undecodable };
}

/**
 * The decoded memberships alone, for every caller that acts on the orgs it can
 * name and has nothing to decide about the ones it cannot.
 */
export async function listMemberships(userId: string): Promise<OrgMembershipRecord[]> {
  return (await listMembershipRows(userId)).memberships;
}

function toMembershipRecord(
  item: Record<string, AttributeValue>,
  userId: string,
): OrgMembershipRecord | undefined {
  const sk = item.sk?.S ?? '';
  const orgId = OrgKeys.parseMembershipSk(sk);
  if (!orgId) {
    console.error('[org-membership] Inverse item has no well-formed membership key — dropped', {
      userId,
      sk,
    });
    return undefined;
  }

  const attributes = decodeRow<OrgMembershipRecord>(item);
  const storedRole = attributes.role ?? '';
  if (!isOrgRole(storedRole)) {
    console.error('[org-membership] Inverse item carries an unrecognized role — dropped', {
      userId,
      orgId,
      role: storedRole,
    });
    return undefined;
  }

  return { joinedAt: '', ...attributes, orgId, role: storedRole };
}

/**
 * Every org the caller belongs to, named for the org switcher.
 *
 * The active org is always in the list, carrying the role the request was
 * authorized under. Its inverse item may not exist yet during the conversion
 * window, and a response whose `role` named an org its `memberships` did not
 * contain would contradict itself. The inverse item may also be a request
 * behind the canonical row the middleware read — a role change committing
 * between the two reads would otherwise have `role` and `memberships` name
 * two different roles for the org the caller is operating in.
 *
 * The active org's name is the read the caller is already making, passed in
 * rather than repeated; every other org costs one profile GetItem, which stays
 * cheap while a second membership can only arrive through an invitation. A
 * profile that cannot be read leaves that org unnamed rather than failing the
 * response.
 */
export async function summarizeMemberships({
  userId,
  activeOrgId,
  activeRole,
  activeOrgName,
}: {
  userId: string;
  activeOrgId: string;
  activeRole?: OrgRole;
  activeOrgName: Promise<string>;
}): Promise<OrgMembershipSummary[]> {
  const memberships = await listMemberships(userId);
  let rows = memberships;
  if (activeRole) {
    const active = memberships.find((membership) => membership.orgId === activeOrgId);
    rows = active
      ? memberships.map((membership) =>
          membership === active ? { ...membership, role: activeRole } : membership,
        )
      : [{ orgId: activeOrgId, role: activeRole, joinedAt: '' }, ...memberships];
  }

  return Promise.all(
    rows.map(async (row) => ({
      orgId: row.orgId,
      orgName: row.orgId === activeOrgId ? await activeOrgName : await resolveOrgName(row.orgId),
      role: row.role,
    })),
  );
}
