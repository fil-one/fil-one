import {
  ConditionalCheckFailedException,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
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

/**
 * Cooldown between user-triggered re-drives of an already-started teardown.
 * Short enough that someone whose teardown was never scheduled at all can get
 * it going, long enough that holding down the button cannot fan out Event
 * invokes of a 900s / 1024MB worker.
 */
export const DELETION_REDRIVE_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Claim the right to re-invoke the teardown worker for this org, at most once
 * per {@link DELETION_REDRIVE_COOLDOWN_MS}. The claim is the conditional write
 * itself, so concurrent requests cannot both win.
 *
 * Deliberately does NOT touch `updatedAt`: that field is the orchestrator's
 * liveness signal, and letting a user's click refresh it would hide a teardown
 * that has actually stopped making progress.
 *
 * @returns true when the caller may invoke, false when the cooldown is live.
 */
export async function claimDeletionRedrive(orgId: string): Promise<boolean> {
  const now = Date.now();
  try {
    await getDynamoClient().send(
      new UpdateItemCommand({
        TableName: Resource.UserInfoTable.name,
        Key: marshall({ pk: DeletionKeys.deletionPk(orgId), sk: DeletionKeys.deletionSk() }),
        UpdateExpression: 'SET lastRedriveAt = :now',
        ConditionExpression:
          'attribute_exists(pk) AND (attribute_not_exists(lastRedriveAt) OR lastRedriveAt < :cutoff)',
        ExpressionAttributeValues: marshall({
          ':now': new Date(now).toISOString(),
          ':cutoff': new Date(now - DELETION_REDRIVE_COOLDOWN_MS).toISOString(),
        }),
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}
