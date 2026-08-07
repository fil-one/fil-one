import { QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { batchGet } from './dynamo-batch-get.js';
import type { OrgDeletionMember } from './dynamo-records.js';

const dynamo = getDynamoClient();

/** A non-empty string attribute of an unmarshalled row, or undefined. */
function stringAttr(row: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = row?.[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** MEMBER# rows → {userId, sub} pairs, the sub resolved via USER#/PROFILE. */
export async function snapshotMembers(orgId: string): Promise<OrgDeletionMember[]> {
  const userIds = await queryMemberUserIds(orgId);
  const profiles = await batchGet(
    Resource.UserInfoTable.name,
    userIds.map((userId) => ({ pk: `USER#${userId}`, sk: 'PROFILE' })),
  );
  const subByPk = new Map(profiles.map((profile) => [profile.pk, stringAttr(profile, 'sub')]));
  return userIds.map((userId) => {
    const sub = subByPk.get(`USER#${userId}`);
    return { userId, ...(sub ? { sub } : {}) };
  });
}

/**
 * The query is paginated on purpose: a silently truncated member list would
 * leave the missing members' Auth0 users alive after teardown.
 */
async function queryMemberUserIds(orgId: string): Promise<string[]> {
  const userIds: string[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: Resource.UserInfoTable.name,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :member)',
        ExpressionAttributeValues: marshall({ ':pk': `ORG#${orgId}`, ':member': 'MEMBER#' }),
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }),
    );
    userIds.push(...(result.Items ?? []).map((item) => item.sk!.S!.slice('MEMBER#'.length)));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return userIds;
}
