import { GetItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import type { DeletionMember } from './deletion-record.js';
import { getProvisionedRegions } from './region-helpers.js';

/**
 * Everything teardown will need, read while the rows still exist. The purge
 * destroys all of it, which is why it is copied onto the DELETION record.
 *
 * Reads are strongly consistent throughout: a member or tenant missed here is
 * never torn down, and nothing later can notice the omission.
 */
export async function snapshotOrgForDeletion(orgId: string): Promise<{
  members: DeletionMember[];
  tenantIds: Record<string, string>;
}> {
  const [members, provisioned] = await Promise.all([
    snapshotMembers(orgId),
    getProvisionedRegions(orgId, { consistent: true }),
  ]);

  return {
    members,
    tenantIds: Object.fromEntries(provisioned.map((r) => [r.orchestrator.id, r.tenantId])),
  };
}

async function snapshotMembers(orgId: string): Promise<DeletionMember[]> {
  const userIds = await listMemberUserIds(orgId);
  return Promise.all(userIds.map((userId) => snapshotMember(userId)));
}

async function listMemberUserIds(orgId: string): Promise<string[]> {
  const dynamo = getDynamoClient();
  const userIds: string[] = [];
  let cursor: Record<string, AttributeValue> | undefined;

  do {
    const page = await dynamo.send(
      new QueryCommand({
        TableName: Resource.UserInfoTable.name,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: marshall({ ':pk': `ORG#${orgId}`, ':prefix': 'MEMBER#' }),
        ProjectionExpression: 'sk',
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      const sk = item.sk?.S;
      if (sk) userIds.push(sk.replace('MEMBER#', ''));
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  return userIds;
}

async function snapshotMember(userId: string): Promise<DeletionMember> {
  const dynamo = getDynamoClient();
  const [profile, billing] = await Promise.all([
    dynamo.send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: `USER#${userId}`, sk: 'PROFILE' }),
        ProjectionExpression: 'sub',
        ConsistentRead: true,
      }),
    ),
    dynamo.send(
      new GetItemCommand({
        TableName: Resource.BillingTable.name,
        Key: marshall({ pk: `CUSTOMER#${userId}`, sk: 'SUBSCRIPTION' }),
        ProjectionExpression: 'stripeCustomerId',
        ConsistentRead: true,
      }),
    ),
  ]);

  const sub = profile.Item?.sub?.S;
  if (!sub) {
    // Without it the Auth0 user survives and the identity row cannot be
    // tombstoned, so the account could be re-created. Refuse the whole confirm.
    throw new Error(`No sub on USER#${userId}/PROFILE; cannot record it for deletion`);
  }

  const stripeCustomerId = billing.Item?.stripeCustomerId?.S;
  return { userId, sub, ...(stripeCustomerId ? { stripeCustomerId } : {}) };
}
