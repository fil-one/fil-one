import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { getStripeClient } from '../lib/stripe-client.js';
import { getStorageSamples } from '../lib/aurora-backoffice.js';
import { calculateAverageUsage } from '../lib/usage-calculator.js';

const dynamo = new DynamoDBClient({});

export interface UsageReportingWorkerPayload {
  userId: string;
  orgId: string;
  subscriptionId: string;
  stripeCustomerId: string;
  currentPeriodStart: string;
  reportDate: string;
}

export async function handler(event: UsageReportingWorkerPayload): Promise<void> {
  const { userId, orgId, subscriptionId, stripeCustomerId, currentPeriodStart, reportDate } = event;

  console.log('[usage-worker] Processing', { userId, orgId, subscriptionId, reportDate });

  const now = new Date().toISOString();
  const samples = await getStorageSamples(orgId, currentPeriodStart, now, '1h');
  const usage = calculateAverageUsage(samples);

  console.log('[usage-worker] Usage calculated', {
    userId,
    orgId,
    sampleCount: usage.sampleCount,
    averageTib: usage.averageTib,
  });

  if (usage.averageTib > 0) {
    const stripe = getStripeClient();
    await stripe.billing.meterEvents.create({
      event_name: Resource.StripeMeterEventName.value,
      payload: {
        stripe_customer_id: stripeCustomerId,
        value: String(usage.averageTib),
      },
      timestamp: Math.floor(Date.now() / 1000),
    });
    console.log('[usage-worker] Stripe meter event created', { stripeCustomerId, averageTib: usage.averageTib });
  }

  // Write audit record
  const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60; // 90 days
  await dynamo.send(
    new PutItemCommand({
      TableName: Resource.BillingTable.name,
      Item: marshall({
        pk: `CUSTOMER#${userId}`,
        sk: `USAGE_REPORT#${reportDate}`,
        orgId,
        subscriptionId,
        stripeCustomerId,
        currentPeriodStart,
        reportDate,
        averageBytesUsed: usage.averageBytesUsed,
        averageTib: usage.averageTib,
        sampleCount: usage.sampleCount,
        reportedToStripe: usage.averageTib > 0,
        createdAt: new Date().toISOString(),
        ttl,
      }),
    }),
  );

  console.log('[usage-worker] Audit record written', { userId, reportDate });
}
