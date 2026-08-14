import { upsertContactSubscriptionStatus } from './hubspot-client.js';
import type { HubSpotLifecycleStatus } from './hubspot-lifecycle-status.js';
import { emitHubSpotLiveWriteFailed } from './hubspot-metrics.js';

/**
 * Mirrors a subscription status onto the customer's HubSpot contact (FIL-828).
 *
 * Swallows every failure so a CRM outage cannot make the webhook 500 and have
 * Stripe replay the billing write. The `hubspot-contact-sync` cron repairs
 * dropped writes; it calls the client directly so failures surface to its counters.
 */
export async function syncHubSpotStatusBestEffort(args: {
  userId: string | undefined;
  status: HubSpotLifecycleStatus;
  email?: string | null;
}): Promise<void> {
  const { userId, status, email } = args;
  if (!userId) return;

  try {
    const outcome = await upsertContactSubscriptionStatus({
      userId,
      status,
      email: email ?? undefined,
    });
    if (outcome === 'unmatched') {
      console.warn('[hubspot-status-sync] No HubSpot contact matched', { userId, status });
    }
  } catch (error) {
    console.error('[hubspot-status-sync] Status write failed (continuing)', {
      userId,
      status,
      error,
    });
    emitHubSpotLiveWriteFailed(error instanceof Error ? error.name : 'unknown');
  }
}
