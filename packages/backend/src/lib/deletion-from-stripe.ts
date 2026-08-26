import { invokeAccountDeletionWorker } from './account-deletion-invoke.js';
import { resolveOrgIdFromSubscription } from './billing-org-lookup.js';
import { commitStripeTriggeredDeletion } from './deletion-confirm-transaction.js';
import { customerSuperseded } from './billing-identity.js';

const LOG = '[deletion-from-stripe]';

/**
 * Commits the full account teardown for an org whose Stripe customer is gone.
 *
 * An admin deleting the org's Stripe customer is the standing response to trial
 * abuse and means the account should go, so this commits the same deletion the
 * confirmation endpoint does, minus the code — there is none to spend.
 *
 * Never throws. Every caller is a Stripe callback, and the record and the sweeper
 * own retries now: a handler that threw would be retried by Stripe for days over
 * a deletion that is already committed, and enough failures disable the endpoint.
 */
export async function startDeletionFromStripe(params: {
  /** Absent when the caller holds only an org — the id feeds the fallback and the logs. */
  userId?: string;
  customerId: string;
  /** From `customer.metadata.orgId`; resolved from the legacy billing row when absent. */
  orgId?: string;
  caller: string;
}): Promise<void> {
  const { userId, customerId, caller } = params;

  try {
    const orgId = params.orgId ?? (userId ? await resolveOrgIdFromSubscription(userId) : undefined);
    if (!orgId) {
      console.error(`${LOG} cannot resolve the org of a deleted customer`, {
        userId,
        customerId,
        caller,
      });
      return;
    }

    // The org outlives its Stripe customers, and this event destroys the whole
    // account: a customer.deleted for one the account replaced months ago must
    // not tear down the service the replacement subscription is paying for.
    if (await customerSuperseded({ source: caller, orgId, customerId })) return;

    // Refused on the teardown's own customer.deleted echo, and on a redelivery.
    const { outcome } = await commitStripeTriggeredDeletion(orgId);
    if (outcome === 'already_deleting') {
      console.log(`${LOG} already committed`, { orgId, customerId, caller });
      return;
    }

    console.log(`${LOG} committed`, { orgId, userId, customerId, caller });
    await invokeAccountDeletionWorker(orgId);
  } catch (err) {
    // No record was written, so the sweeper cannot see this one either.
    console.error(`${LOG} failed to commit; needs an operator`, {
      userId,
      customerId,
      caller,
      error: err,
    });
  }
}
