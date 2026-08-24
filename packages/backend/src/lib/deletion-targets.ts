import { GetItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import type { DeletionMember } from './deletion-record.js';
import { getProvisionedRegions } from './region-helpers.js';

const LOG = '[deletion-targets]';

/**
 * Everything teardown needs, resolved at the start of each pass. The scrub retains
 * every row read here, so a re-drive resolves the same answer.
 *
 * Reads are strongly consistent throughout: a member or tenant missed here is
 * never torn down, and nothing later can notice the omission.
 */
export async function resolveDeletionTargets(orgId: string): Promise<{
  members: DeletionMember[];
  tenantIds: Record<string, string>;
}> {
  const [members, provisioned] = await Promise.all([
    resolveMembers(orgId),
    getProvisionedRegions(orgId, { consistent: true }),
  ]);

  return {
    members,
    tenantIds: Object.fromEntries(provisioned.map((r) => [r.orchestrator.id, r.tenantId])),
  };
}

async function resolveMembers(orgId: string): Promise<DeletionMember[]> {
  const userIds = await listMemberUserIds(orgId);
  const members = await Promise.all(userIds.map((userId) => resolveMember(userId)));
  return members.filter((m): m is DeletionMember => m !== undefined);
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

async function resolveMember(userId: string): Promise<DeletionMember | undefined> {
  const dynamo = getDynamoClient();
  const [profile, billing] = await Promise.all([
    dynamo.send(
      new GetItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: `USER#${userId}`, sk: 'PROFILE' }),
        // `sub` is a DynamoDB reserved word, hence #sub.
        ProjectionExpression: '#sub',
        ExpressionAttributeNames: { '#sub': 'sub' },
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
    // Nothing to delete in Auth0 and no identity row to stamp. Loud, because it
    // means the account can outlive its org, but it must not wedge the pass.
    console.error(`${LOG} no sub on USER#${userId}/PROFILE; leaving that member behind`);
    return undefined;
  }

  const stripeCustomerId = billing.Item?.stripeCustomerId?.S;
  return { userId, sub, ...(stripeCustomerId ? { stripeCustomerId } : {}) };
}
