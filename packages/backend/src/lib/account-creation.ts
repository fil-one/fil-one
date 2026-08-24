import { TransactWriteItemsCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
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
 *
 * `email` is the address Auth0 has verified, and is stamped on the user profile
 * only when it is verified: the org paths read that field to decide what a
 * removal revokes, so an unverified address there would let somebody else's
 * pending invitation be swept — or held live — under a name they do not own.
 * Absent when the account signs up before verifying; the login path stamps it
 * on the first verified request.
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
  email?: string;
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
              // What the profile's address was last stamped from. This row is
              // read on every authenticated request; the profile is not, so
              // the marker is what keeps the stamp off the hot path.
              ...(email ? { profileEmail: { S: email } } : {}),
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

/**
 * Bring the user profile's address up to date with the one Auth0 has verified.
 *
 * Accounts created before the profile carried an address, and accounts that
 * signed up unverified, reach their first verified request without one; an
 * address change leaves a stale one. Both are repaired here, on the request
 * that already knows the verified address.
 *
 * `profileEmail` on the identity row records what the profile was last stamped
 * from. That row is read on every authenticated request anyway, so a profile
 * already holding the current address costs nothing beyond a string compare —
 * the writes happen once per address, not once per request. The profile is
 * written first: a marker without the row it claims would stop the repair
 * forever, while a row without its marker is repeated once and is idempotent.
 *
 * Unverified addresses are never stamped: sweeping invitations by an address
 * the holder has not proven they own would revoke somebody else's.
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
  stampedEmail,
}: {
  sub: string;
  userId: string;
  email: string | null;
  emailVerified: boolean;
  stampedEmail?: string;
}): Promise<void> {
  if (!email || !emailVerified || stampedEmail === email) return;
  const tableName = Resource.UserInfoTable.name;

  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: `USER#${userId}` }, sk: { S: 'PROFILE' } },
        UpdateExpression: 'SET #email = :email',
        ExpressionAttributeNames: { '#email': 'email' },
        ExpressionAttributeValues: { ':email': { S: email } },
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: `SUB#${sub}` }, sk: { S: 'IDENTITY' } },
        UpdateExpression: 'SET profileEmail = :email',
        ExpressionAttributeValues: { ':email': { S: email } },
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  } catch (err) {
    console.error('[account-creation] Could not stamp the verified email on the profile', {
      userId,
      error: err,
    });
  }
}
