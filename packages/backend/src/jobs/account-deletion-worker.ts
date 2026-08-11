import { runAccountDeletion } from '../lib/account-deletion.js';

export interface AccountDeletionWorkerPayload {
  orgId: string;
}

/**
 * Async teardown worker for self-serve account deletion (FIL-112). Invoked
 * Event-style by the delete-account handler right after the user confirms,
 * and re-invoked by the reconciler cron for records that stall. There is no
 * per-step state machine: every teardown in runAccountDeletion is idempotent,
 * so each invocation simply re-runs ALL of them; a throw here (surfaced to
 * Lambda's async retry) means the whole pass is re-driven until the record
 * is marked DONE.
 */
export async function handler(event: AccountDeletionWorkerPayload): Promise<void> {
  const { orgId } = event;
  if (!orgId) {
    // Throw (never warn-and-return): a swallowed invalid payload marks the
    // async invoke successful, hiding the bug from Lambda's retry/DLQ and
    // error metrics while the org's teardown silently never runs.
    throw new Error(`[account-deletion-worker] Missing orgId in payload: ${JSON.stringify(event)}`);
  }

  try {
    await runAccountDeletion(orgId);
  } catch (err) {
    // Only genuine failures reach here. A healthy pass that has to wait out
    // Stripe's search-index lag waits IN-PASS (see stripeSearchLagRemaining) and
    // never throws, so an `Errors` datapoint from this function always means
    // something is actually wrong — which is what makes it alertable.
    console.error('[account-deletion-worker] Teardown step failed; will be retried', {
      orgId,
      error: err,
    });
    throw err;
  }
}
