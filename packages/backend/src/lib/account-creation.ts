import { UpdateItemCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { OrgRole } from '@filone/shared';
import { AuditSubjects, auditEvent, commitAudited, userActor } from './audit.js';
import { getDynamoClient } from './ddb-client.js';
import { OrgKeys } from './org-membership.js';
import type { OrgMembership } from './org-membership.js';
import { OrgSetupStatus } from './org-setup-status.js';
import { reserveOrgSlug } from './org-slug.js';

export interface NewAccountParams {
  sub: string;
  userId: string;
  orgId: string;
  orgName: string;
  email?: string;
  name?: string;
}

/**
 * Create the account on first login: identity, profiles, membership, the org's
 * owner count, and the `org.created` audit event, in one transaction. Returns
 * the membership it wrote, so the caller uses the row it just created rather
 * than racing a read against its own write.
 *
 * `email` is the address Auth0 has verified, and is stamped on the user profile
 * only when it is verified: the org paths read that field to decide what a
 * removal revokes, so an unverified address there would let somebody else's
 * pending invitation be swept — or held live — under a name they do not own.
 * Absent when the account signs up before verifying; the login path stamps it
 * on the first verified request. The audit actor carries the same address.
 *
 * `name` is the display name Auth0 holds, and carries no verification gate: it
 * is what the member roster shows a human, and it decides nothing. Absent when
 * the identity provider gives us none, and the login path stamps it if one
 * appears later.
 */
export async function createNewUserAndOrg({
  sub,
  userId,
  orgId,
  orgName,
  email,
  name,
}: NewAccountParams): Promise<OrgMembership> {
  const now = new Date().toISOString();
  const { slug, reservationItem } = await reserveOrgSlug({ orgId, name: orgName });

  // Spans three tables: identity and profiles in UserInfoTable, membership and
  // the owner count in OrgTable, the event in AuditTable. The event rides the
  // same transaction as the rows it describes, so an org cannot come into
  // existence unrecorded.
  //
  // The one write where the log yields rather than blocks. This runs inside the
  // auth middleware, so an AuditTable outage that cancelled the transaction
  // would fail every new customer's first login as a 401 and send them round the
  // auth loop again — an unrecorded org is recoverable, an account nobody can
  // create is not. The retry lands the seven rows and counts the dropped event.
  await commitAudited({
    onAuditFailure: 'retry-without-audit',
    event: auditEvent({
      type: 'org.created',
      actor: userActor({ userId, email }),
      orgId,
      subject: AuditSubjects.org(orgId),
      details: { orgName, source: 'signup' },
    }),
    items: accountRows({ sub, userId, orgId, orgName, slug, email, name, now, reservationItem }),
  });

  return { orgId, userId, role: OrgRole.Owner, joinedAt: now, source: 'signup' };
}

/**
 * Create an additional organization for an account that already exists — the
 * console's "Create organization" action, once an account may own more than
 * one. Sibling to {@link createNewUserAndOrg}, reusing its row shapes minus the
 * `SUB#`/`USER#PROFILE` identity rows, which already exist for this caller.
 *
 * `source: 'manual'` on both the membership row and the audit event, distinct
 * from `'signup'`: this org did not come with the account, the account asked
 * for it.
 */
export interface CreateAdditionalOrgParams {
  userId: string;
  orgName: string;
  logoUrl?: string;
  email?: string;
}

export interface CreatedOrg {
  orgId: string;
  orgName: string;
  slug: string;
  logoUrl?: string;
}

export async function createAdditionalOrg({
  userId,
  orgName,
  logoUrl,
  email,
}: CreateAdditionalOrgParams): Promise<CreatedOrg> {
  const orgId = crypto.randomUUID();
  const now = new Date().toISOString();
  const { slug, reservationItem } = await reserveOrgSlug({ orgId, name: orgName });

  const userInfoTableName = Resource.UserInfoTable.name;
  const orgTableName = Resource.OrgTable.name;

  const items: TransactWriteItem[] = [
    {
      // Create-only, the same guard `accountRows` puts on the identity row:
      // `orgId` is a fresh UUID, so a collision here would mean the id was
      // reused, not that the org already existed.
      Put: {
        TableName: userInfoTableName,
        Item: {
          pk: { S: `ORG#${orgId}` },
          sk: { S: 'PROFILE' },
          name: { S: orgName },
          slug: { S: slug },
          // Named on the way in, unlike signup's derived name — there is no
          // naming step to send this org through.
          nameConfirmed: { BOOL: true },
          auroraSetupStatus: { S: OrgSetupStatus.FILONE_ORG_CREATED },
          createdBy: { S: userId },
          createdAt: { S: now },
          ...(logoUrl ? { logoUrl: { S: logoUrl } } : {}),
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Put: {
        TableName: orgTableName,
        Item: {
          pk: { S: OrgKeys.orgPk(orgId) },
          sk: { S: OrgKeys.orgMetaSk() },
          ownerCount: { N: '1' },
        },
      },
    },
    {
      Put: {
        TableName: orgTableName,
        Item: {
          pk: { S: OrgKeys.orgPk(orgId) },
          sk: { S: OrgKeys.memberSk(userId) },
          role: { S: OrgRole.Owner },
          joinedAt: { S: now },
          source: { S: 'manual' },
        },
      },
    },
    {
      Put: {
        TableName: orgTableName,
        Item: {
          pk: { S: OrgKeys.userPk(userId) },
          sk: { S: OrgKeys.membershipSk(orgId) },
          role: { S: OrgRole.Owner },
          joinedAt: { S: now },
        },
      },
    },
    reservationItem,
  ];

  await commitAudited({
    items,
    event: auditEvent({
      type: 'org.created',
      actor: userActor({ userId, email }),
      orgId,
      subject: AuditSubjects.org(orgId),
      details: { orgName, source: 'manual' },
    }),
  });

  return { orgId, orgName, slug, ...(logoUrl ? { logoUrl } : {}) };
}

/**
 * Bring the user profile's address and display name up to date with what Auth0
 * holds.
 *
 * Accounts created before the profile carried either field, and accounts that
 * signed up unverified, reach their first request without them; a change to
 * either leaves a stale value. Both are repaired here, on the request that
 * already knows the current claims.
 *
 * `profileEmail` and `profileName` on the identity row record what the profile
 * was last stamped from. That row is read on every authenticated request
 * anyway, so a profile already holding both current values costs nothing beyond
 * two string compares — the writes happen once per change, not once per
 * request, and only the field that changed is written. The profile is written
 * first: a marker without the row it claims would stop the repair forever,
 * while a row without its marker is repeated once and is idempotent.
 *
 * Unverified addresses are never stamped: sweeping invitations by an address
 * the holder has not proven they own would revoke somebody else's. The name
 * carries no such gate — it is shown to humans and decides nothing — and an
 * absent name is left absent rather than clearing a name we already hold.
 *
 * Best-effort by design. The address decides what a removal revokes, not
 * whether the caller is authenticated, so a failed write is logged and the next
 * request retries.
 */
export async function stampVerifiedEmail({
  sub,
  userId,
  email,
  emailVerified,
  name,
  stampedEmail,
  stampedName,
}: {
  sub: string;
  userId: string;
  email: string | null;
  emailVerified: boolean;
  name?: string | null;
  stampedEmail?: string;
  stampedName?: string;
}): Promise<void> {
  const stampEmail = Boolean(email) && emailVerified && stampedEmail !== email;
  const stampName = Boolean(name) && stampedName !== name;
  if (!stampEmail && !stampName) return;

  const tableName = Resource.UserInfoTable.name;
  const profileSets: string[] = [];
  const markerSets: string[] = [];
  const attributeNames: Record<string, string> = {};
  const attributeValues: Record<string, { S: string }> = {};

  if (stampEmail) {
    profileSets.push('#email = :email');
    markerSets.push('profileEmail = :email');
    attributeNames['#email'] = 'email';
    attributeValues[':email'] = { S: email as string };
  }
  if (stampName) {
    profileSets.push('#name = :name');
    markerSets.push('profileName = :name');
    attributeNames['#name'] = 'name';
    attributeValues[':name'] = { S: name as string };
  }

  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: `USER#${userId}` }, sk: { S: 'PROFILE' } },
        UpdateExpression: `SET ${profileSets.join(', ')}`,
        ExpressionAttributeNames: attributeNames,
        ExpressionAttributeValues: attributeValues,
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: `SUB#${sub}` }, sk: { S: 'IDENTITY' } },
        UpdateExpression: `SET ${markerSets.join(', ')}`,
        ExpressionAttributeValues: attributeValues,
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  } catch (err) {
    console.error('[account-creation] Could not stamp the Auth0 claims on the profile', {
      userId,
      error: err,
    });
  }
}

/**
 * The seven rows an account is: identity, both profiles, the owner count, the
 * membership, its inverse item, and the org's slug reservation. Spans two
 * tables, and travels as one transaction so no half of an account can exist
 * without the other.
 *
 * `email` is stamped on the user profile only when Auth0 has verified it, and
 * `name` carries no such gate. The identity row records what the profile was
 * last stamped from.
 */
function accountRows({
  sub,
  userId,
  orgId,
  orgName,
  slug,
  email,
  name,
  now,
  reservationItem,
}: {
  sub: string;
  userId: string;
  orgId: string;
  orgName: string;
  slug: string;
  email?: string;
  name?: string;
  now: string;
  reservationItem: TransactWriteItem;
}): TransactWriteItem[] {
  return [
    ...identityAndUserProfileRows({ sub, userId, orgId, email, name, now }),
    ...orgAndMembershipRows({ orgId, orgName, slug, userId, now }),
    reservationItem,
  ];
}

/**
 * The identity row and the user profile: what a `SUB#{sub}` maps to, and the
 * `USER#{userId}` row it maps to it. Both live in UserInfoTable.
 */
function identityAndUserProfileRows({
  sub,
  userId,
  orgId,
  email,
  name,
  now,
}: {
  sub: string;
  userId: string;
  orgId: string;
  email?: string;
  name?: string;
  now: string;
}): TransactWriteItem[] {
  const tableName = Resource.UserInfoTable.name;

  return [
    {
      Put: {
        TableName: tableName,
        Item: {
          pk: { S: `SUB#${sub}` },
          sk: { S: 'IDENTITY' },
          userId: { S: userId },
          orgId: { S: orgId },
          createdAt: { S: now },
          // What the profile's address and name were last stamped from. This
          // row is read on every authenticated request; the profile is not, so
          // the markers are what keep the stamp off the hot path.
          ...(email ? { profileEmail: { S: email } } : {}),
          ...(name ? { profileName: { S: name } } : {}),
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: {
          pk: { S: `USER#${userId}` },
          sk: { S: 'PROFILE' },
          sub: { S: sub },
          orgId: { S: orgId },
          createdAt: { S: now },
          ...(email ? { email: { S: email } } : {}),
          ...(name ? { name: { S: name } } : {}),
        },
      },
    },
  ];
}

/**
 * The org's own rows: its profile (UserInfoTable), and its owner count,
 * membership, and inverse membership item (OrgTable). The slug reservation
 * rides separately — `accountRows` appends it, since `createAdditionalOrg`
 * below builds the identical shape without going through this helper at all.
 */
function orgAndMembershipRows({
  orgId,
  orgName,
  slug,
  userId,
  now,
}: {
  orgId: string;
  orgName: string;
  slug: string;
  userId: string;
  now: string;
}): TransactWriteItem[] {
  const orgTableName = Resource.OrgTable.name;

  return [
    {
      Put: {
        TableName: Resource.UserInfoTable.name,
        Item: {
          pk: { S: `ORG#${orgId}` },
          sk: { S: 'PROFILE' },
          name: { S: orgName },
          slug: { S: slug },
          // The name here is derived, not chosen. False sends the account
          // through the naming step; `PATCH /api/org` flips it.
          nameConfirmed: { BOOL: false },
          auroraSetupStatus: { S: OrgSetupStatus.FILONE_ORG_CREATED },
          createdBy: { S: userId },
          createdAt: { S: now },
        },
      },
    },
    {
      // The last-Owner invariant's counter, in OrgTable beside the rows it
      // counts, so every owner-set transaction is single-table. Stamped
      // from day one so no org is ever created without it and the
      // conversion has nothing to repair for accounts created while it runs.
      Put: {
        TableName: orgTableName,
        Item: {
          pk: { S: OrgKeys.orgPk(orgId) },
          sk: { S: OrgKeys.orgMetaSk() },
          ownerCount: { N: '1' },
        },
      },
    },
    {
      // Authoritative membership. The account's creator owns it: an org of
      // one whose single member can do everything, which is what every
      // account is until invitations ship.
      Put: {
        TableName: orgTableName,
        Item: {
          pk: { S: OrgKeys.orgPk(orgId) },
          sk: { S: OrgKeys.memberSk(userId) },
          role: { S: OrgRole.Owner },
          joinedAt: { S: now },
          source: { S: 'signup' },
        },
      },
    },
    {
      // Inverse item, written in the same transaction so a membership and
      // the list it appears in can never disagree about a role.
      Put: {
        TableName: orgTableName,
        Item: {
          pk: { S: OrgKeys.userPk(userId) },
          sk: { S: OrgKeys.membershipSk(orgId) },
          role: { S: OrgRole.Owner },
          joinedAt: { S: now },
        },
      },
    },
  ];
}
