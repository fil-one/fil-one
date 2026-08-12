import {
  ConditionalCheckFailedException,
  UpdateItemCommand,
  type UpdateItemCommandInput,
  type UpdateItemCommandOutput,
} from '@aws-sdk/client-dynamodb';
import { getDynamoClient } from './ddb-client.js';

const dynamo = getDynamoClient();

/**
 * Updates a billing row only if it still exists.
 *
 * Account teardown purges `CUSTOMER#{userId}/SUBSCRIPTION`, and UpdateItem
 * creates the item when absent — so an unguarded write from a Stripe webhook
 * that lands after the purge would resurrect a deleted org's billing record,
 * complete with a subscription status nothing will ever clear.
 *
 * A refused write is a no-op rather than an error. The caller has nothing to
 * fix, and a webhook handler that threw would be retried by Stripe for days.
 * Returns undefined when the row was gone.
 */
export async function sendGuardedBillingUpdate(
  input: UpdateItemCommandInput,
  context: { userId: string; caller: string },
): Promise<UpdateItemCommandOutput | undefined> {
  try {
    return await dynamo.send(
      new UpdateItemCommand({ ...input, ConditionExpression: 'attribute_exists(pk)' }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      console.warn('[billing-guard] skipped write to a purged billing row', context);
      return undefined;
    }
    throw err;
  }
}
