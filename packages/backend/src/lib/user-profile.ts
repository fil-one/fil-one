import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';

/**
 * The `USER#{userId}/PROFILE` row in UserInfoTable, as the org paths read it.
 *
 * A user's name and address are Auth0's, and this row is the copy the control
 * plane holds: written when we learn them, absent on a row created before we
 * did. So every caller here treats both fields as optional and treats a failed
 * read as "we do not know", never as "there is none" — the difference matters,
 * because one of those callers uses the address to decide what to revoke.
 *
 * The address is written by the paths that learn a VERIFIED one: account
 * creation, a login whose stamp marker has gone stale, and accepting an
 * invitation ({@link rememberVerifiedEmail}). Nothing writes an unverified
 * claim here — the address decides which invitations a removal retires, and an
 * address somebody typed is an address somebody chose.
 *
 * The name has no such gate: creation and login stamp whatever display name
 * the ID token carries. The roster shows it and nothing else reads it, so a
 * claimed name risks nothing; it is display, never identity.
 */
export interface UserProfile {
  email?: string;
  name?: string;
  /**
   * The org the account logs in to, which `authMiddleware` reads off the
   * identity row and fences on. The deletion scrub moves both rows together
   * (`repointHomeOrg`), so this copy answers the same question without a second
   * key to resolve.
   */
  orgId?: string;
}

/**
 * One member's profile fields, or undefined when the row cannot be read.
 *
 * Swallowing the read error is deliberate and the callers differ on what it
 * costs them: the roster renders that member unnamed, a removal loses the
 * address it would have swept invitations by and says so in its own log, and an
 * acceptance carries one fence rather than two. None is a reason to fail a
 * request whose authoritative row — the membership — has already been read.
 *
 * `consistentRead` is for the caller whose answer gates a write: a fence that
 * has just been raised on the org this row names must not be missed by a
 * replica that has not caught up.
 */
export async function readUserProfile(
  userId: string,
  options: { consistentRead?: boolean } = {},
): Promise<UserProfile | undefined> {
  try {
    const { Item } = await getDynamoClient().send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: { pk: { S: `USER#${userId}` }, sk: { S: 'PROFILE' } },
        ProjectionExpression: 'email, #name, orgId',
        ExpressionAttributeNames: { '#name': 'name' },
        ...(options.consistentRead ? { ConsistentRead: true } : {}),
      }),
    );
    return { email: Item?.email?.S, name: Item?.name?.S, orgId: Item?.orgId?.S };
  } catch (err) {
    console.error('[user-profile] Profile read failed', { userId, error: err });
    return undefined;
  }
}

/**
 * The Auth0 subject behind a user id, or undefined when the profile row
 * carries none or cannot be read.
 *
 * Split out from {@link readUserProfile} because almost nothing needs `sub` —
 * it names the `SUB#{sub}/IDENTITY` row a caller repoints, today only a
 * removal that leaves the account with a floor org to log in to.
 *
 * `consistentRead` matters here for the same reason it does on
 * {@link readUserProfile}: a caller about to repoint this row from inside its
 * own transaction must not miss a write from moments ago.
 */
export async function readUserSub(
  userId: string,
  options: { consistentRead?: boolean } = {},
): Promise<string | undefined> {
  try {
    const { Item } = await getDynamoClient().send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: { pk: { S: `USER#${userId}` }, sk: { S: 'PROFILE' } },
        // `sub` is a DynamoDB reserved word, hence #sub.
        ProjectionExpression: '#sub',
        ExpressionAttributeNames: { '#sub': 'sub' },
        ...(options.consistentRead ? { ConsistentRead: true } : {}),
      }),
    );
    return Item?.sub?.S;
  } catch (err) {
    console.error('[user-profile] Sub read failed', { userId, error: err });
    return undefined;
  }
}

/**
 * Record the address a session proved it holds.
 *
 * Removal sweeps the invitations addressed TO the member it removes, and it
 * finds them by the address on this row: a removed member holding a live
 * invitation to themselves otherwise redeems it and walks back in at whatever
 * role that link carries. Acceptance is one of the two moments the control
 * plane learns a verified address, and until it writes one the sweep cannot run
 * for anybody who joined by invitation.
 *
 * Conditioned on the row existing, so a login racing a deletion cannot upsert a
 * profile holding nothing but an address — the deletion census reads this row
 * for the member's `sub` and fails closed on one it cannot decode.
 *
 * Best-effort, and outside the transaction that admitted the member: the
 * acceptance has already landed, the caller IS a member, and failing their
 * request over a field that only a later removal reads would answer failure for
 * a request that succeeded. The log line is what says the sweep will be narrow.
 */
export async function rememberVerifiedEmail(userId: string, email: string): Promise<void> {
  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: { pk: { S: `USER#${userId}` }, sk: { S: 'PROFILE' } },
        UpdateExpression: 'SET email = :email',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':email': { S: email } },
      }),
    );
  } catch (err) {
    console.error('[user-profile] Could not record the member’s address', { userId, error: err });
  }
}
