import type Stripe from 'stripe';
import { Resource } from 'sst';
import { SubscriptionStatus } from '@filone/shared';
import { sendGuardedBillingUpdate } from './deletion-guards.js';
import {
  assertRegionSyncSucceeded,
  syncTenantStatusInProvisionedRegions,
} from './region-helpers.js';

/**
 * Returns false when the billing guard rejects the write (see
 * {@link sendGuardedBillingUpdate}) — the caller must then skip tenant unlocks.
 * The handler 400s earlier on a missing record, so that only happens when a
 * teardown claimed or purged it mid-request.
 */
export async function saveBillingRecord(
  userId: string,
  subscription: Stripe.Subscription,
  paymentMethodId: string,
  mappedStatus: SubscriptionStatus,
): Promise<boolean> {
  const pm = subscription.default_payment_method;
  let paymentMethodLast4 = '';
  let paymentMethodBrand = '';
  let paymentMethodExpMonth = 0;
  let paymentMethodExpYear = 0;

  if (pm && typeof pm === 'object' && pm.card) {
    paymentMethodLast4 = pm.card.last4;
    paymentMethodBrand = pm.card.brand;
    paymentMethodExpMonth = pm.card.exp_month;
    paymentMethodExpYear = pm.card.exp_year;
  }

  return (
    (await sendGuardedBillingUpdate({
      TableName: Resource.BillingTable.name,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression:
        'SET subscriptionId = :subId, subscriptionStatus = :status, currentPeriodEnd = :periodEnd, paymentMethodId = :pmId, paymentMethodLast4 = :last4, paymentMethodBrand = :brand, paymentMethodExpMonth = :expMonth, paymentMethodExpYear = :expYear, updatedAt = :now REMOVE trialEndsAt',
      ExpressionAttributeValues: {
        ':subId': { S: subscription.id },
        ':status': { S: mappedStatus },
        ':periodEnd': {
          S: new Date(subscription.items.data[0].current_period_end * 1000).toISOString(),
        },
        ':pmId': { S: paymentMethodId },
        ':last4': { S: paymentMethodLast4 },
        ':brand': { S: paymentMethodBrand },
        ':expMonth': { N: String(paymentMethodExpMonth) },
        ':expYear': { N: String(paymentMethodExpYear) },
        ':now': { S: new Date().toISOString() },
      },
    })) !== null
  );
}

// Unlocks the org's tenant on every orchestrator where it exists (Aurora, FTH,
// ...). Each orchestrator resolves its own tenant and is skipped when the org
// has none there, so this is a no-op for orchestrators the org never used.
export async function unlockAllProvisionedRegions(orgId: string): Promise<void> {
  try {
    const { outcomes, refusedForDeletion } = await syncTenantStatusInProvisionedRegions(
      orgId,
      'active',
    );
    assertRegionSyncSucceeded(outcomes);
    // The org-profile `deleting` guard refused the unlock (FIL-112): report that, never "unlocked".
    if (refusedForDeletion) {
      console.warn('[billing-activation] Tenant unlock refused: org deletion in progress', {
        orgId,
      });
      return;
    }
    console.log('[billing-activation] Tenant unlocked', { orgId });
  } catch (error) {
    console.error('[billing-activation] Failed to unlock tenant', {
      orgId,
      error,
      cause: error instanceof Error ? error.cause : undefined,
    });
    throw error;
  }
}
