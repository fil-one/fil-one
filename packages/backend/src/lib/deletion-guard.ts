import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { UpdateItemCommandOutput } from '@aws-sdk/client-dynamodb';
import { getDynamoClient } from './ddb-client.js';

/**
 * The billing guard: the condition every write to a customer's billing record
 * carries, so our own teardown-driven `subscriptions.cancel` cannot echo back as
 * a webhook event that upserts a zombie record or re-activates a disabled tenant.
 *
 * It covers BillingTable `CUSTOMER#{userId}/SUBSCRIPTION` writes and nothing
 * else, and that narrowness is structural rather than an oversight: an attribute
 * on a row cannot fence the write that CREATES the row — there is no row yet to
 * carry it. Record-creating billing writers are therefore held off by the
 * identity tombstone, and non-BillingTable surfaces (access keys, RAG keys,
 * bucket rows) by the org-profile `deleting` guard.
 *
 * `deletionRequestedAt` is armed by the account teardown when it claims the
 * record. Until it is armed the condition reduces to `attribute_exists(pk)`,
 * which is the half that blocks upsert-driven resurrection of purged records.
 *
 */
export const DELETION_GUARD = 'attribute_exists(pk) AND attribute_not_exists(deletionRequestedAt)';

const dynamo = getDynamoClient();

/**
 * Returns null when the guard rejects the write (record purged or org
 * mid-deletion) — callers must then skip follow-on tenant status syncs.
 */
export async function sendGuardedBillingUpdate(
  input: Omit<ConstructorParameters<typeof UpdateItemCommand>[0], 'ConditionExpression'>,
): Promise<UpdateItemCommandOutput | null> {
  try {
    return await dynamo.send(
      new UpdateItemCommand({ ...input, ConditionExpression: DELETION_GUARD }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      console.warn('[deletion-guard] Billing record missing or org mid-deletion; skipping update', {
        key: input.Key,
      });
      return null;
    }
    throw err;
  }
}
