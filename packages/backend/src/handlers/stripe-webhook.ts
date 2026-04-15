import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import Stripe from 'stripe';
import {
  PAID_GRACE_DAYS,
  SubscriptionStatus,
  TRIAL_GRACE_DAYS,
  mapStripeStatus,
} from '@filone/shared';
import { Resource } from 'sst';
import { updateTenantStatus } from '../lib/aurora-backoffice.js';
import { getDynamoClient } from '../lib/ddb-client.js';
import { setOrgAuroraTenantStatus } from '../lib/org-profile.js';
import { isOrgSetupComplete } from '../lib/org-setup-status.js';
import { getStripeClient, getWebhookSecret } from '../lib/stripe-client.js';

const dynamo = getDynamoClient();

/**
 * Stripe webhook handler — NO auth middleware.
 * Verifies Stripe signature, processes billing events, and writes to billing table.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const tableName = Resource.BillingTable.name;
  const stripe = getStripeClient();

  // 1. Get raw body for signature verification
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
    : (event.body ?? '');

  const signatureHeader = event.headers['stripe-signature'];

  if (!signatureHeader) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'Missing stripe-signature header' }),
    };
  }

  // 2. Verify webhook signature
  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      await getWebhookSecret(),
    );
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', (err as Error).message);
    return { statusCode: 400, body: JSON.stringify({ message: 'Invalid signature' }) };
  }

  // 3. Idempotency — atomic claim-or-skip
  const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days
  const idempotencyKey = { pk: { S: `WEBHOOK#${stripeEvent.id}` }, sk: { S: 'EVENT' } };
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall({
          pk: `WEBHOOK#${stripeEvent.id}`,
          sk: 'EVENT',
          eventType: stripeEvent.type,
          processedAt: new Date().toISOString(),
          ttl,
        }),
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.warn('[stripe-webhook] Already processed event:', stripeEvent.id);
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }
    console.error('[stripe-webhook] Idempotency check failed:', (err as Error).message);
    return { statusCode: 500, body: JSON.stringify({ message: 'Idempotency check error' }) };
  }

  // 4. Process event
  try {
    switch (stripeEvent.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = stripeEvent.data.object as Stripe.Subscription;
        await handleSubscriptionUpdate(tableName, subscription);
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(tableName, subscription);
        break;
      }
      case 'customer.updated': {
        const customer = stripeEvent.data.object as Stripe.Customer;
        await handleCustomerUpdated(tableName, customer);
        break;
      }
      case 'customer.subscription.trial_will_end': {
        const subscription = stripeEvent.data.object as Stripe.Subscription;
        console.log('[stripe-webhook] Trial ending soon for customer:', subscription.customer);
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        await handlePaymentSucceeded(tableName, invoice);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        await handlePaymentFailed(tableName, invoice);
        break;
      }
      default:
        console.log('[stripe-webhook] Unhandled event type:', stripeEvent.type);
    }
  } catch (err) {
    console.error('[stripe-webhook] Error processing event:', (err as Error).message);
    // Release idempotency claim so Stripe retries can reprocess
    try {
      await dynamo.send(new DeleteItemCommand({ TableName: tableName, Key: idempotencyKey }));
    } catch (deleteErr) {
      console.error(
        '[stripe-webhook] Failed to release idempotency claim:',
        (deleteErr as Error).message,
      );
    }
    return { statusCode: 500, body: JSON.stringify({ message: 'Processing error' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
}

function getCustomerIdString(customer: string | Stripe.Customer | Stripe.DeletedCustomer): string {
  return typeof customer === 'string' ? customer : customer.id;
}

async function resolveAuroraTenantId(
  userId: string,
  tableName: string,
): Promise<{ orgId: string; auroraTenantId: string } | null> {
  // 1. Get orgId from billing record
  const billingResult = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      ProjectionExpression: 'orgId',
    }),
  );
  const orgId = billingResult.Item?.orgId?.S;
  if (!orgId) {
    console.warn('[stripe-webhook] No orgId on billing record for user:', userId);
    return null;
  }

  // 2. Get auroraTenantId from org profile
  const orgResult = await dynamo.send(
    new GetItemCommand({
      TableName: Resource.UserInfoTable.name,
      Key: {
        pk: { S: `ORG#${orgId}` },
        sk: { S: 'PROFILE' },
      },
      ProjectionExpression: 'auroraTenantId, setupStatus',
    }),
  );
  const auroraTenantId = orgResult.Item?.auroraTenantId?.S;
  const setupStatus = orgResult.Item?.setupStatus?.S;
  if (!auroraTenantId || !isOrgSetupComplete(setupStatus)) {
    console.warn('[stripe-webhook] Aurora tenant not ready for org:', orgId);
    return null;
  }

  return { orgId, auroraTenantId };
}

async function handleCustomerUpdated(tableName: string, customer: Stripe.Customer): Promise<void> {
  const userId = customer.metadata?.userId;
  if (!userId) {
    throw new Error(`[stripe-webhook] No userId in metadata for customer: ${customer.id}`);
  }

  const defaultPm = customer.invoice_settings?.default_payment_method;
  if (!defaultPm) {
    throw new Error('[stripe-webhook] No default_payment_method on customer.updated');
  }

  const stripe = getStripeClient();
  const pm =
    typeof defaultPm === 'string' ? await stripe.paymentMethods.retrieve(defaultPm) : defaultPm;
  await updatePaymentMethod(tableName, userId, pm);
}

async function updatePaymentMethod(
  tableName: string,
  userId: string,
  pm: Stripe.PaymentMethod,
): Promise<void> {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression:
        'SET paymentMethodId = :pmId, paymentMethodLast4 = :last4, paymentMethodBrand = :brand, paymentMethodExpMonth = :expMonth, paymentMethodExpYear = :expYear, updatedAt = :now',
      ExpressionAttributeValues: {
        ':pmId': { S: pm.id },
        ':last4': { S: pm.card?.last4 ?? '' },
        ':brand': { S: pm.card?.brand ?? '' },
        ':expMonth': { N: String(pm.card?.exp_month ?? 0) },
        ':expYear': { N: String(pm.card?.exp_year ?? 0) },
        ':now': { S: new Date().toISOString() },
      },
      ConditionExpression: 'attribute_exists(pk)',
    }),
  );
}

async function handleSubscriptionUpdate(
  tableName: string,
  subscription: Stripe.Subscription,
): Promise<void> {
  const customerId = getCustomerIdString(subscription.customer);
  const mappedStatus = mapStripeStatus(subscription.status);

  if (mappedStatus === null) {
    console.warn('[stripe-webhook] Unmappable Stripe status, skipping update', {
      stripeStatus: subscription.status,
      subscriptionId: subscription.id,
      customerId,
    });
    return;
  }

  // Find billing record by Stripe customer ID — we need to scan or use a GSI.
  // For MVP, use metadata.userId set during customer creation.
  const userId = subscription.metadata?.userId;
  if (!userId) {
    // Try fetching from Stripe customer metadata
    const stripe = getStripeClient();
    const customer = await stripe.customers.retrieve(customerId);
    if ('deleted' in customer && customer.deleted) {
      console.warn('[stripe-webhook] Customer deleted, skipping subscription update');
      return;
    }
    const metaUserId = customer.metadata?.userId;
    if (!metaUserId) {
      console.warn('[stripe-webhook] No userId in metadata for customer:', customerId);
      return;
    }
    await updateBillingRecord(tableName, metaUserId, subscription, mappedStatus);
    return;
  }

  await updateBillingRecord(tableName, userId, subscription, mappedStatus);
}

async function updateBillingRecord(
  tableName: string,
  userId: string,
  subscription: Stripe.Subscription,
  mappedStatus: SubscriptionStatus,
): Promise<void> {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression:
        'SET subscriptionId = :subId, subscriptionStatus = :status, currentPeriodEnd = :periodEnd, currentPeriodStart = :periodStart, updatedAt = :now REMOVE gracePeriodEndsAt, canceledAt',
      ExpressionAttributeValues: {
        ':subId': { S: subscription.id },
        ':status': { S: mappedStatus },
        ':periodEnd': {
          S: new Date((subscription.items.data[0]?.current_period_end ?? 0) * 1000).toISOString(),
        },
        ':periodStart': {
          S: new Date((subscription.items.data[0]?.current_period_start ?? 0) * 1000).toISOString(),
        },
        ':now': { S: new Date().toISOString() },
      },
    }),
  );
}

async function handleSubscriptionDeleted(
  tableName: string,
  subscription: Stripe.Subscription,
): Promise<void> {
  const stripe = getStripeClient();
  const customerId = getCustomerIdString(subscription.customer);
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer && customer.deleted) return;

  const userId = customer.metadata?.userId;
  if (!userId) return;

  const graceDays = subscription.trial_end ? TRIAL_GRACE_DAYS : PAID_GRACE_DAYS;

  const now = new Date();
  const gracePeriodEndsAt = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000).toISOString();

  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression:
        'SET subscriptionStatus = :status, canceledAt = :now, gracePeriodEndsAt = :grace, updatedAt = :now',
      ExpressionAttributeValues: {
        ':status': { S: SubscriptionStatus.GracePeriod },
        ':now': { S: now.toISOString() },
        ':grace': { S: gracePeriodEndsAt },
      },
    }),
  );

  // Best-effort: set Aurora tenant to WRITE_LOCKED during grace period.
  // If this fails, the daily grace-period-enforcer cron will also attempt
  // WRITE_LOCK for active grace periods missing it.
  try {
    const resolved = await resolveAuroraTenantId(userId, tableName);
    if (resolved) {
      await updateTenantStatus({ tenantId: resolved.auroraTenantId, status: 'WRITE_LOCKED' });
      await setOrgAuroraTenantStatus(resolved.orgId, 'WRITE_LOCKED');
      console.log('[stripe-webhook] Aurora tenant WRITE_LOCKED', {
        userId,
        orgId: resolved.orgId,
        auroraTenantId: resolved.auroraTenantId,
      });
    }
  } catch (error) {
    console.error('[stripe-webhook] Failed to WRITE_LOCK Aurora tenant', {
      userId,
      error: (error as Error).message,
    });
  }
}

async function handlePaymentSucceeded(tableName: string, invoice: Stripe.Invoice): Promise<void> {
  if (!invoice.customer) return;
  const stripe = getStripeClient();
  const customerId = getCustomerIdString(invoice.customer);
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer && customer.deleted) return;

  const userId = customer.metadata?.userId;
  if (!userId) return;

  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression:
        'SET subscriptionStatus = :active, lastPaymentAt = :now, updatedAt = :now REMOVE gracePeriodEndsAt, lastPaymentFailedAt, canceledAt',
      ExpressionAttributeValues: {
        ':active': { S: SubscriptionStatus.Active },
        ':now': { S: new Date().toISOString() },
      },
    }),
  );

  // Best-effort: re-enable Aurora tenant if recovering from PastDue/GracePeriod.
  // If this fails, the tenant may remain locked until manual intervention.
  try {
    const resolved = await resolveAuroraTenantId(userId, tableName);
    if (resolved) {
      await updateTenantStatus({ tenantId: resolved.auroraTenantId, status: 'ACTIVE' });
      await setOrgAuroraTenantStatus(resolved.orgId, 'ACTIVE');
      console.log('[stripe-webhook] Aurora tenant re-activated', {
        userId,
        orgId: resolved.orgId,
        auroraTenantId: resolved.auroraTenantId,
      });
    }
  } catch (error) {
    console.error('[stripe-webhook] Failed to re-activate Aurora tenant', {
      userId,
      error: (error as Error).message,
    });
  }
}

async function handlePaymentFailed(tableName: string, invoice: Stripe.Invoice): Promise<void> {
  if (!invoice.customer) return;
  const stripe = getStripeClient();
  const customerId = getCustomerIdString(invoice.customer);
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer && customer.deleted) return;

  const userId = customer.metadata?.userId;
  if (!userId) return;

  // Set PastDue but do NOT start grace period — Stripe Smart Retries will
  // continue attempting payment. Grace period only begins when Stripe cancels
  // the subscription after all retries are exhausted.
  const now = new Date().toISOString();
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression:
        'SET subscriptionStatus = :status, lastPaymentFailedAt = :failedAt, updatedAt = :now',
      ExpressionAttributeValues: {
        ':status': { S: SubscriptionStatus.PastDue },
        ':failedAt': { S: now },
        ':now': { S: now },
      },
    }),
  );
}
