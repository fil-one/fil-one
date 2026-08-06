import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { DeletionKeys, type OrgDeletionRecord } from './dynamo-records.js';

// Separate module so handlers that only check for an in-flight deletion don't
// import account-deletion.ts — it loads the orchestrator registry, which
// crashes lambdas without orchestrator env vars.
export async function readDeletionRecord(orgId: string): Promise<OrgDeletionRecord | undefined> {
  const { Item } = await getDynamoClient().send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: marshall({ pk: DeletionKeys.deletionPk(orgId), sk: DeletionKeys.deletionSk() }),
      ConsistentRead: true,
    }),
  );
  return Item ? (unmarshall(Item) as OrgDeletionRecord) : undefined;
}
