import { GetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';

const dynamo = getDynamoClient();

/** The raw `ORG#{orgId}/PROFILE` item from UserInfoTable. */
export type OrgProfileItem = Record<string, AttributeValue>;

// Fetches the `ORG#{orgId}/PROFILE` row shared by all orchestrators, so
// callers consulting several orchestrators read the row once instead of once
// per orchestrator.
//
// Read semantics:
// - Eventually consistent on purpose: tenant-id attributes (auroraTenantId,
//   fthTenantId) are write-once, so a stale read can only transiently report
//   "not provisioned" right after setup — never a wrong tenant id. Setup
//   flows that need read-after-write (processTenantSetup) issue their own
//   ConsistentRead and do not go through this helper.
// - No ProjectionExpression: it would not reduce consumed RCUs, and different
//   orchestrators need different attributes from the same row.
export async function getOrgProfile(orgId: string): Promise<OrgProfileItem | undefined> {
  const { Item } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: { pk: { S: `ORG#${orgId}` }, sk: { S: 'PROFILE' } },
    }),
  );
  return Item;
}
