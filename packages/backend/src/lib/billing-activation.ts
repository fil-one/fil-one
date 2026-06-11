import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type Stripe from 'stripe';
import { Resource } from 'sst';
import { SubscriptionStatus } from '@filone/shared';
import { getDynamoClient } from './ddb-client.js';
import {
  assertRegionSyncSucceeded,
  syncTenantStatusInProvisionedRegions,
} from './region-helpers.js';

const dynamo = getDynamoClient();

export async function saveBillingRecord(
  userId: string,
  subscription: Stripe.Subscription,
  paymentMethodId: string,
  mappedStatus: SubscriptionStatus,
): Promise<void> {
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

  await dynamo.send(
    new UpdateItemCommand({
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
    }),
  );
}

// Unlocks the org's tenant on every orchestrator where it exists (Aurora, FTH,
// ...). Each orchestrator resolves its own tenant and is skipped when the org
// has none there, so this is a no-op for orchestrators the org never used.
export async function unlockAllProvisionedRegions(orgId: string): Promise<void> {
  try {
    assertRegionSyncSucceeded(await syncTenantStatusInProvisionedRegions(orgId, 'active'));
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
