import { TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { OrgRole } from '@filone/shared';
import { getDynamoClient } from './ddb-client.js';
import { OrgKeys } from './org-membership.js';
import type { OrgMembership } from './org-membership.js';
import { OrgSetupStatus } from './org-setup-status.js';

/**
 * Create the account on first login: identity, profiles, membership, and the
 * org's owner count, in one transaction. Returns the membership it wrote, so
 * the caller uses the row it just created rather than racing a read against
 * its own write.
 */
export async function createNewUserAndOrg({
  sub,
  userId,
  orgId,
  orgName,
}: {
  sub: string;
  userId: string;
  orgId: string;
  orgName: string;
}): Promise<OrgMembership> {
  const tableName = Resource.UserInfoTable.name;
  const orgTableName = Resource.OrgTable.name;
  const now = new Date().toISOString();

  // Spans both tables: identity and profiles live in UserInfoTable, membership
  // and the owner count in OrgTable.
  await getDynamoClient().send(
    new TransactWriteItemsCommand({
      TransactItems: [
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
      ],
    }),
  );

  return { orgId, userId, role: OrgRole.Owner, joinedAt: now, source: 'signup' };
}
