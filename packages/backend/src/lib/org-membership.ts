import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { OrgRole } from '@filone/shared';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';

/** True when the user's MEMBER# row in the org carries the Admin role. */
export async function isOrgAdmin(orgId: string, userId: string): Promise<boolean> {
  const memberRow = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: `ORG#${orgId}`, sk: `MEMBER#${userId}` }),
      // Access-control read — must see the latest role, not a stale replica.
      ConsistentRead: true,
    }),
  );
  return memberRow.Item?.role?.S === OrgRole.Admin;
}
