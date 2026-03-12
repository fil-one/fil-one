import {
  DynamoDBClient,
  DeleteItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import Stripe from 'stripe';
import { SubscriptionStatus } from '@filone/shared';
import { Resource } from 'sst';
import { getStripeClient, getWebhookSecret } from '../lib/stripe-client.js';

const dynamo = new DynamoDBClient({});

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

async function handleSubscriptionUpdate(
  tableName: string,
  subscription: Stripe.Subscription,
): Promise<void> {
  const customerId = getCustomerIdString(subscription.customer);

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
    await updateBillingRecord(tableName, metaUserId, subscription);
    return;
  }

  await updateBillingRecord(tableName, userId, subscription);
}

async function updateBillingRecord(
  tableName: string,
  userId: string,
  subscription: Stripe.Subscription,
): Promise<void> {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression:
        'SET subscriptionId = :subId, subscriptionStatus = :status, currentPeriodEnd = :periodEnd, updatedAt = :now REMOVE gracePeriodEndsAt, canceledAt',
      ExpressionAttributeValues: {
        ':subId': { S: subscription.id },
        ':status': { S: subscription.status },
        ':periodEnd': {
          S: new Date((subscription.items.data[0]?.current_period_end ?? 0) * 1000).toISOString(),
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

  const now = new Date();
  const gracePeriodEndsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

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
        'SET subscriptionStatus = :active, lastPaymentAt = :now, updatedAt = :now REMOVE gracePeriodEndsAt',
      ExpressionAttributeValues: {
        ':active': { S: SubscriptionStatus.Active },
        ':now': { S: new Date().toISOString() },
      },
    }),
  );
}

async function handlePaymentFailed(tableName: string, invoice: Stripe.Invoice): Promise<void> {
  if (!invoice.customer) return;
  const stripe = getStripeClient();
  const customerId = getCustomerIdString(invoice.customer);
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer && customer.deleted) return;

  const userId = customer.metadata?.userId;
  if (!userId) return;

  const now = new Date();
  const gracePeriodEndsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        pk: { S: `CUSTOMER#${userId}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression:
        'SET subscriptionStatus = :status, gracePeriodEndsAt = :grace, updatedAt = :now',
      ExpressionAttributeValues: {
        ':status': { S: SubscriptionStatus.PastDue },
        ':grace': { S: gracePeriodEndsAt },
        ':now': { S: now.toISOString() },
      },
    }),
  );
}
