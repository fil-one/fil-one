import { runAccountDeletion } from '../lib/account-deletion.js';

export interface AccountDeletionWorkerPayload {
  orgId: string;
  /**
   * Run a pass even though the DELETION record is already DONE (FIL-112).
   * Set only by the orchestrator's resurrection sweep, which has just observed
   * residue for this org from after the teardown completed — rows that came
   * back, or a resurrected customer's Redaction Job still unfinished. Without it
   * `runAccountDeletion` short-circuits on DONE and the invocation does
   * nothing at all — see the DONE early-return there.
   */
  resweep?: boolean;
}

/**
 * Async teardown worker for self-serve account deletion (FIL-112). Invoked
 * Event-style by the delete-account handler right after the user confirms,
 * and re-invoked by the orchestrator cron for records that stall. There is no
 * per-step state machine: every teardown in runAccountDeletion is idempotent,
 * so each invocation simply re-runs ALL of them.
 *
 * A throw is surfaced to Lambda's async retry, which is bounded (2 attempts).
 * After that, an ordinary teardown is re-driven because the throw left the record
 * non-DONE. A resweep is not: its record is ALREADY DONE and a failure never moves
 * that back, so the orchestrator's resurrection sweep is the only thing that
 * returns — see `sweepResurrectedOrgs` (lib/deletion-resurrection-sweep.ts).
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
    await runAccountDeletion(orgId, { resweep: event.resweep === true });
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
