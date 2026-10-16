import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { deleteMembership, resolvePersonalOrgId } from '../destructive/invite.util.ts';
import { credential, type OrgUser } from './users.util.ts';

// Seeding and repairs for the multi-org suite's own accounts. Row shapes follow
// packages/backend/src/lib/account-creation.ts and org-membership.ts, as
// invite.util.ts does for the rows it writes.

const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

function table(name: 'OrgTable' | 'UserInfoTable' | 'BillingTable'): string {
  return (Resource as unknown as Record<string, { name: string }>)[name].name;
}

/** The host every uploaded logo and avatar is served from. */
export function imageHost(): string {
  const bucket = (Resource as unknown as Record<string, { name: string }>).OrgLogoBucketName.name;
  return `${bucket}.s3.${process.env.AWS_REGION ?? 'us-east-1'}.amazonaws.com`.toLowerCase();
}

/** The app's user id for a test account, from its identity row. */
export async function userIdOf(user: OrgUser): Promise<string> {
  const { Item } = await client.send(
    new GetItemCommand({
      TableName: table('UserInfoTable'),
      Key: { pk: { S: `SUB#${credential(user, 'AUTH0_ID')}` }, sk: { S: 'IDENTITY' } },
      ConsistentRead: true,
    }),
  );
  const userId = Item?.userId?.S;
  if (!userId) throw new Error(`No account for the ${user} user yet; run multi-org-setup first.`);
  return userId;
}

export { resolvePersonalOrgId as homeOrgOf };

/** Set an org's name, and whether it has been through the naming step. */
export async function setOrgName(
  orgId: string,
  { name, nameConfirmed = true }: { name?: string; nameConfirmed?: boolean },
): Promise<void> {
  await client.send(
    new UpdateItemCommand({
      TableName: table('UserInfoTable'),
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
      UpdateExpression: `SET nameConfirmed = :confirmed${name ? ', #name = :name' : ''} REMOVE floorOrg`,
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: name ? { '#name': 'name' } : undefined,
      ExpressionAttributeValues: {
        ':confirmed': { BOOL: nameConfirmed },
        ...(name ? { ':name': { S: name } } : {}),
      },
    }),
  );
}

/**
 * Leave the account in its home org and nowhere else: orgs it owns there are
 * deleted, memberships elsewhere dropped.
 */
export async function resetToHomeOrg(userId: string): Promise<void> {
  const home = await resolvePersonalOrgId(userId);
  for (const row of await query('OrgTable', `USER#${userId}`, 'MEMBERSHIP#')) {
    const orgId = row.sk!.S!.slice('MEMBERSHIP#'.length);
    if (orgId === home) continue;
    if (row.role?.S === 'owner') await deleteOrg(orgId);
    else await deleteMembership({ orgId, userId });
  }
}

/** Every row an org owns: its partition, its members' inverse rows, its profile, beta and billing. */
export async function deleteOrg(orgId: string): Promise<void> {
  for (const row of await query('OrgTable', `ORG#${orgId}`)) {
    const sk = row.sk!.S!;
    if (sk.startsWith('MEMBER#')) {
      await deleteItem('OrgTable', `USER#${sk.slice('MEMBER#'.length)}`, `MEMBERSHIP#${orgId}`);
    }
    await deleteItem('OrgTable', `ORG#${orgId}`, sk);
  }
  for (const row of await query('BillingTable', `ORG#${orgId}`)) {
    await deleteItem('BillingTable', `ORG#${orgId}`, row.sk!.S!);
  }
  await deleteItem('UserInfoTable', `ORG#${orgId}`, 'PROFILE');
  await deleteItem('UserInfoTable', `ORG#${orgId}`, 'ORGS_BETA');
}

/** Clear the org's hourly logo-upload allowance. */
export async function resetLogoUploadRate(orgId: string): Promise<void> {
  await deleteItem('OrgTable', `ORG#${orgId}`, 'LOGO_UPLOAD_RATE');
}

/** Put the account back as Owner of `orgId` and point both home pointers at it. */
export async function restoreHomeOrg(user: OrgUser, userId: string, orgId: string): Promise<void> {
  const joinedAt = new Date().toISOString();
  for (const [pk, sk] of [
    [`ORG#${orgId}`, `MEMBER#${userId}`],
    [`USER#${userId}`, `MEMBERSHIP#${orgId}`],
  ]) {
    await client.send(
      new PutItemCommand({
        TableName: table('OrgTable'),
        Item: {
          pk: { S: pk },
          sk: { S: sk },
          role: { S: 'owner' },
          joinedAt: { S: joinedAt },
          ...(pk.startsWith('ORG#') ? { source: { S: 'signup' } } : {}),
        },
      }),
    );
  }
  await setHomeOrg(user, userId, orgId);
}

/** Point the account's profile and identity rows at `orgId`. */
export async function setHomeOrg(user: OrgUser, userId: string, orgId: string): Promise<void> {
  for (const [pk, sk] of [
    [`USER#${userId}`, 'PROFILE'],
    [`SUB#${credential(user, 'AUTH0_ID')}`, 'IDENTITY'],
  ]) {
    await client.send(
      new UpdateItemCommand({
        TableName: table('UserInfoTable'),
        Key: { pk: { S: pk }, sk: { S: sk } },
        UpdateExpression: 'SET orgId = :orgId',
        ExpressionAttributeValues: { ':orgId': { S: orgId } },
      }),
    );
  }
}

async function deleteItem(
  name: 'OrgTable' | 'UserInfoTable' | 'BillingTable',
  pk: string,
  sk: string,
): Promise<void> {
  await client.send(
    new DeleteItemCommand({ TableName: table(name), Key: { pk: { S: pk }, sk: { S: sk } } }),
  );
}

async function query(
  name: 'OrgTable' | 'BillingTable',
  pk: string,
  skPrefix?: string,
): Promise<Record<string, AttributeValue>[]> {
  const items: Record<string, AttributeValue>[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const { Items, LastEvaluatedKey } = await client.send(
      new QueryCommand({
        TableName: table(name),
        KeyConditionExpression: skPrefix ? 'pk = :pk AND begins_with(sk, :sk)' : 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': { S: pk },
          ...(skPrefix && { ':sk': { S: skPrefix } }),
        },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(Items ?? []));
    startKey = LastEvaluatedKey;
  } while (startKey);
  return items;
}
