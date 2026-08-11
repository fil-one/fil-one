// The DynamoDB *condition* half of the FIL-112 guard; setting deletionRequestedAt lives elsewhere.
import { ConditionalCheckFailedException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { UpdateItemCommandOutput } from '@aws-sdk/client-dynamodb';
import { getDynamoClient } from './ddb-client.js';
import { reportMetric } from './metrics.js';

/**
 * Without this, our own teardown-driven subscriptions.cancel echoes back as
 * webhook events that upsert zombie records or re-activate a disabled tenant.
 *
 * Scope — what this fence does and does not cover today. It applies to
 * BillingTable `CUSTOMER#{userId}/SUBSCRIPTION` only; it is not a
 * whole-account fence, and it is not applied to every writer in the codebase.
 *
 * Guarded here:
 * - `handlers/stripe-webhook.ts` (payment-method, subscription created/updated,
 *   subscription deleted, invoice paid, invoice failed)
 * - `lib/billing-activation.ts` `saveBillingRecord` and
 *   `lib/deleted-customer-cleanup.ts` — both inline the condition and
 *   hand-roll the catch rather than calling {@link sendGuardedBillingUpdate};
 *   the behaviour is identical, the log line is not.
 * - `jobs/grace-period-enforcer.ts` (rejection → outcome `skipped`)
 * - `middleware/subscription-guard.ts` and `handlers/get-billing.ts`
 *   (`cacheStripePrice` + the lazy trial→grace transition)
 *
 * Known gaps, owned by later branches in the FIL-112 stack — do not read this
 * module as covering them:
 * - `lib/create-billing-trial.ts` — the record-creating write, which this
 *   attribute cannot fence: there is no record left to carry it. Fencing
 *   `transitionExpiredTrial` means the next request finds no item
 *   (`middleware/subscription-guard.ts`) → `ensureTrialEntitlement` →
 *   `createBillingTrial`, which mints a **new** Stripe customer, a **new**
 *   trial subscription, and an unconditional row for a purged user.
 *   `if_not_exists(subscriptionStatus, …)` prevents clobbering, not creation.
 *   Needs a different signal (the identity tombstone / fence B).
 * - `handlers/create-setup-intent.ts` — the `stripeCustomerId` upsert is
 *   unconditioned and the sibling Put is create-only, so both can land after a
 *   purge. Closed by the session/tombstone work.
 * - BillingTable `ORG#{orgId}/USAGE_REPORT#` (`jobs/usage-reporting-worker.ts`)
 *   — unconditioned, and not covered by the teardown's purge prefixes at all.
 * - Every non-BillingTable surface (access keys, RAG keys, bucket rows), which
 *   **will be** fenced on the org profile's `deleting` flag rather than on this
 *   attribute (a later batch); today they are unfenced — that flag has no
 *   reader outside tenant setup.
 *
 * Nothing in this branch *writes* `deletionRequestedAt` — the teardown that
 * sets it lands further up the stack — so here the condition reduces to
 * `attribute_exists(pk)`, which is what blocks upsert-driven resurrection.
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
