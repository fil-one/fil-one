import { QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { batchGet } from './dynamo-batch-get.js';
import type { OrgDeletionBillingCustomer, OrgDeletionMember } from './dynamo-records.js';

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

/**
 * EVERY member billing record with Stripe references is snapshotted, in
 * members order. The one-customer-per-org invariant makes this normally a
 * single entry, but if it is ever violated the extras' CUSTOMER# rows still
 * get purged — their Stripe pointers must survive on the snapshot so teardown
 * cancels/redacts each of them.
 */
export async function snapshotBilling(
  members: OrgDeletionMember[],
): Promise<{ billingCustomers?: OrgDeletionBillingCustomer[] }> {
  const rows = await batchGet(
    Resource.BillingTable.name,
    members.map((member) => ({ pk: `CUSTOMER#${member.userId}`, sk: 'SUBSCRIPTION' })),
  );
  const rowByPk = new Map(rows.map((row) => [row.pk, row]));
  const billingCustomers = members
    .map((member) => rowByPk.get(`CUSTOMER#${member.userId}`))
    .map((row) => {
      const stripeCustomerId = stringAttr(row, 'stripeCustomerId');
      const subscriptionId = stringAttr(row, 'subscriptionId');
      return {
        ...(stripeCustomerId ? { stripeCustomerId } : {}),
        ...(subscriptionId ? { subscriptionId } : {}),
      };
    })
    .filter((customer) => customer.stripeCustomerId ?? customer.subscriptionId);
  if (billingCustomers.length === 0) return {};
  if (billingCustomers.length > 1) {
    console.warn(
      '[deletion-snapshot] Multiple member billing customers found (invariant violation)',
      { count: billingCustomers.length },
    );
  }
  return { billingCustomers };
}
