import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getDynamoClient } from './ddb-client.js';
import { DeletionKeys, type OrgDeletionRecord } from './dynamo-records.js';

/**
 * Read the org's teardown state record (FIL-112). Lives in its own module —
 * NOT in account-deletion.ts — so request handlers that only need to check
 * whether a deletion is in flight (create-deletion-challenge) don't pull the
 * full teardown lib into their bundle: that lib imports the orchestrator
 * registry, which instantiates the Aurora/FTH clients at module load and
 * crashes on lambdas without the orchestrator env vars.
 */
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
