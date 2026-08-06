// The DynamoDB *condition* half of the FIL-112 guard; setting deletionRequestedAt lives elsewhere.
import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { getDynamoClient } from './ddb-client.js';

/**
 * Without this, our own teardown-driven subscriptions.cancel echoes back as
 * webhook events that upsert zombie records or re-activate a disabled tenant.
 */
export const DELETION_GUARD = 'attribute_exists(pk) AND attribute_not_exists(deletionRequestedAt)';

const dynamo = getDynamoClient();

/**
 * Returns null when the guard rejects the write (record purged or org
 * mid-deletion) — callers must then skip follow-on tenant status syncs.
 */
export async function sendGuardedBillingUpdate(
  input: Omit<ConstructorParameters<typeof UpdateItemCommand>[0], 'ConditionExpression'>,
  context: Record<string, unknown>,
): Promise<import('@aws-sdk/client-dynamodb').UpdateItemCommandOutput | null> {
  try {
    return await dynamo.send(
      new UpdateItemCommand({ ...input, ConditionExpression: DELETION_GUARD }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      console.warn(
        '[deletion-guard] Billing record missing or org mid-deletion; skipping update',
        context,
      );
      return null;
    }
    throw err;
  }
}
