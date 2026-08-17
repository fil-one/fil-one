import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { OrgRole } from '@filone/shared';
import { AuditSubjects, auditEvent, commitAudited, userActor } from './audit.js';
import { OrgKeys } from './org-membership.js';
import type { OrgMembership } from './org-membership.js';
import { OrgSetupStatus } from './org-setup-status.js';

/**
 * Create the account on first login: identity, profiles, membership, the org's
 * owner count, and the `org.created` audit event, in one transaction. Returns
 * the membership it wrote, so the caller uses the row it just created rather
 * than racing a read against its own write.
 */
export async function createNewUserAndOrg({
  sub,
  userId,
  orgId,
  orgName,
  email,
}: {
  sub: string;
  userId: string;
  orgId: string;
  orgName: string;
  /** The verified claim when there is one; the audit actor carries it. */
  email?: string;
}): Promise<OrgMembership> {
  const now = new Date().toISOString();

  // Spans three tables: identity and profiles in UserInfoTable, membership and
  // the owner count in OrgTable, the event in AuditTable. The event rides the
  // same transaction as the rows it describes, so an org cannot come into
  // existence unrecorded.
  //
  // The one write where the log yields rather than blocks. This runs inside the
  // auth middleware, so an AuditTable outage that cancelled the transaction
  // would fail every new customer's first login as a 401 and send them round the
  // auth loop again — an unrecorded org is recoverable, an account nobody can
  // create is not. The retry lands the six rows and counts the dropped event.
  await commitAudited({
    onAuditFailure: 'retry-without-audit',
    event: auditEvent({
      type: 'org.created',
      actor: userActor({ userId, email }),
      orgId,
      subject: AuditSubjects.org(orgId),
      details: { orgName, source: 'signup' },
    }),
    items: accountRows({ sub, userId, orgId, orgName, now }),
  });

  return { orgId, userId, role: OrgRole.Owner, joinedAt: now, source: 'signup' };
}

/**
 * The six rows an account is: identity, both profiles, the owner count, the
 * membership, and its inverse item. Spans two tables, and travels as one
 * transaction so no half of an account can exist without the other.
 */
function accountRows({
  sub,
  userId,
  orgId,
  orgName,
  now,
}: {
  sub: string;
  userId: string;
  orgId: string;
  orgName: string;
  now: string;
}): TransactWriteItem[] {
  const tableName = Resource.UserInfoTable.name;
  const orgTableName = Resource.OrgTable.name;

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
        },
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: {
          pk: { S: `ORG#${orgId}` },
          sk: { S: 'PROFILE' },
          name: { S: orgName },
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
