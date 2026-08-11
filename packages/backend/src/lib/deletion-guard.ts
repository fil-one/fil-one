import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { UpdateItemCommandOutput } from '@aws-sdk/client-dynamodb';
import { getDynamoClient } from './ddb-client.js';
import { reportMetric } from './metrics.js';

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
 * `closeOutDeletedCustomer` (lib/deleted-customer-cleanup.ts) inlines this
 * condition instead of calling {@link sendGuardedBillingUpdate}, on purpose: its
 * customer-without-record case is expected-benign and must not count into
 * `BillingDeletionGuardRejected`.
 */
export const DELETION_GUARD = 'attribute_exists(pk) AND attribute_not_exists(deletionRequestedAt)';

const dynamo = getDynamoClient();

/**
 * Emits the rejection as an EMF counter alongside the warn so it is alarmable
 * in Grafana (no CloudWatch alarm resources exist in this repo by design).
 *
 * This matters because a rejection is self-sustaining: when the guard refuses
 * a lazy `trialing → grace_period` transition the new status is never
 * persisted, so the trigger condition never clears and every subsequent request
 * re-attempts and re-rejects — an unbounded stream of warns and billed failed
 * conditional writes that a log line alone leaves unalarmable.
 */
function emitGuardRejection(context: Record<string, unknown>): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [{ Name: 'BillingDeletionGuardRejected', Unit: 'Count' }],
        },
      ],
    },
    ...context,
    // Last so a `context` key of the same name can never shadow the datum.
    BillingDeletionGuardRejected: 1,
  });
}

/**
 * Returns null when the guard rejects the write (record purged or org
 * mid-deletion) — callers must then skip follow-on tenant status syncs.
 */
export async function sendGuardedBillingUpdate(
  input: Omit<ConstructorParameters<typeof UpdateItemCommand>[0], 'ConditionExpression'>,
  context: Record<string, unknown>,
): Promise<UpdateItemCommandOutput | null> {
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
      emitGuardRejection(context);
      return null;
    }
    throw err;
  }
}
