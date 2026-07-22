import { runAccountDeletion } from '../lib/account-deletion.js';

export interface AccountDeletionWorkerPayload {
  orgId: string;
}

/**
 * Async teardown worker for self-serve account deletion (FIL-112). Invoked
 * Event-style by the delete-account handler right after the user confirms,
 * and re-invoked by the reconciler cron for records that stall. The state
 * machine in runAccountDeletion is resumable, so a throw here (surfaced to
 * Lambda's async retry) picks up at the failed step.
 */
export async function handler(event: AccountDeletionWorkerPayload): Promise<void> {
  const { orgId } = event;
  if (!orgId) {
    console.error('[account-deletion-worker] Missing orgId in payload', { event });
    return;
  }

  try {
    await runAccountDeletion(orgId);
  } catch (err) {
    console.error('[account-deletion-worker] Teardown step failed; will be retried', {
      orgId,
      error: err,
    });
    throw err;
  }
}
