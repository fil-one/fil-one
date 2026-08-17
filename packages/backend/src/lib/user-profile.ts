import { GetItemCommand } from '@aws-sdk/client-dynamodb';
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
 */
export interface UserProfile {
  email?: string;
  name?: string;
}

/**
 * One member's profile fields, or undefined when the row cannot be read.
 *
 * Swallowing the read error is deliberate and the callers differ on what it
 * costs them: the roster renders that member unnamed, while a removal loses the
 * address it would have swept invitations by and says so in its own log. Neither
 * is a reason to fail a request whose authoritative row — the membership — has
 * already been read.
 */
export async function readUserProfile(userId: string): Promise<UserProfile | undefined> {
  try {
    const { Item } = await getDynamoClient().send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: { pk: { S: `USER#${userId}` }, sk: { S: 'PROFILE' } },
        ProjectionExpression: 'email, #name',
        ExpressionAttributeNames: { '#name': 'name' },
      }),
    );
    return { email: Item?.email?.S, name: Item?.name?.S };
  } catch (err) {
    console.error('[user-profile] Profile read failed', { userId, error: err });
    return undefined;
  }
}
