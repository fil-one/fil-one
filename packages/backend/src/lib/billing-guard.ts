import {
  ConditionalCheckFailedException,
  UpdateItemCommand,
  type UpdateItemCommandInput,
  type UpdateItemCommandOutput,
} from '@aws-sdk/client-dynamodb';
import { getDynamoClient } from './ddb-client.js';

const dynamo = getDynamoClient();

/**
 * Updates a billing row unless the teardown has scrubbed it.
 *
 * The profile fence cannot stop Stripe, which holds no session and retries its
 * callbacks for days, so the one row those callbacks write carries its own fence.
 * `customer.updated` matters most: it is the only writer that can put payment-card
 * details back onto a scrubbed row.
 *
 * One clause, not two, and only because the teardown retains the row. UpdateItem
 * evaluates a condition on a missing item as though its attributes are absent, so
 * `attribute_not_exists(deletedAt)` is *true* for a row that does not exist and
 * would create one. Under a purge design this condition alone would be a bug.
 *
 * A refused write is a no-op rather than an error. The caller has nothing to
 * fix, and a webhook handler that threw would be retried by Stripe for days over
 * a row that will never accept the write. Returns undefined when refused.
 */
export async function sendGuardedBillingUpdate(
  input: UpdateItemCommandInput,
  context: { userId: string; caller: string },
): Promise<UpdateItemCommandOutput | undefined> {
  try {
    return await dynamo.send(
      new UpdateItemCommand({ ...input, ConditionExpression: 'attribute_not_exists(deletedAt)' }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      console.warn('[billing-guard] skipped write to a scrubbed billing row', context);
      return undefined;
    }
    throw err;
  }
}
