import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type Stripe from 'stripe';
import { Resource } from 'sst';
import { SubscriptionStatus } from '@filone/shared';
import { getDynamoClient } from './ddb-client.js';
import { ResponseBuilder } from './response-builder.js';
import { updateTenantStatus } from './aurora/aurora-backoffice.js';
import { setOrgAuroraTenantStatus } from './org-profile.js';
import { isOrgSetupComplete } from './org-setup-status.js';

const dynamo = getDynamoClient();

export type PaymentMethodResolution = string | APIGatewayProxyResultV2;

export async function resolveSetupIntentPaymentMethod(
  stripe: Stripe,
  stripeCustomerId: string,
): Promise<PaymentMethodResolution> {
  const setupIntents = await stripe.setupIntents.list({
    customer: stripeCustomerId,
    limit: 1,
  });

  const latestSetupIntent = setupIntents.data[0];
  if (!latestSetupIntent || latestSetupIntent.status !== 'succeeded') {
    return new ResponseBuilder()
      .status(400)
      .body({
        message: 'No confirmed payment method found. Please complete the payment setup first.',
      })
      .build();
  }

  const pm = latestSetupIntent.payment_method;
  const paymentMethodId = typeof pm === 'string' ? pm : pm?.id;

  if (!paymentMethodId) {
    return new ResponseBuilder()
      .status(400)
      .body({ message: 'Payment method not found on setup intent.' })
      .build();
  }

  return paymentMethodId;
}

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

export async function unlockAuroraTenant(orgId: string): Promise<void> {
  const { Item: orgProfile } = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
      },
    }),
  );
  const auroraTenantId = orgProfile?.auroraTenantId?.S;
  const setupStatus = orgProfile?.setupStatus?.S;
  if (!auroraTenantId || !isOrgSetupComplete(setupStatus)) {
    throw new Error(`Aurora tenant setup is not complete for org ${orgId}`);
  }
  try {
    await updateTenantStatus({ tenantId: auroraTenantId, status: 'ACTIVE' });
    await setOrgAuroraTenantStatus(orgId, 'ACTIVE');
    console.log('[billing-activation] Aurora tenant unlocked', { orgId, auroraTenantId });
  } catch (error) {
    console.error('[billing-activation] Failed to unlock Aurora tenant', {
      orgId,
      error,
      cause: error instanceof Error ? error.cause : undefined,
    });
    throw error;
  }
}
