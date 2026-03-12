import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Resource } from 'sst';
import { TIB_BYTES } from '@filone/shared';
import { getStripeClient } from '../lib/stripe-client.js';
import { getStorageSamples } from '../lib/aurora-backoffice.js';
import { calculateAverageUsage } from '../lib/usage-calculator.js';

const dynamo = new DynamoDBClient({});

export interface UsageReportingWorkerPayload {
  orgId: string;
  subscriptionId: string;
  stripeCustomerId: string;
  currentPeriodStart: string;
  reportDate: string;
}

export async function handler(event: UsageReportingWorkerPayload): Promise<void> {
  const { orgId, subscriptionId, stripeCustomerId, currentPeriodStart, reportDate } = event;

  console.log('[usage-worker] Processing', { orgId, subscriptionId, reportDate });

  const now = new Date().toISOString();
  const samples = await getStorageSamples({
    tenantId: orgId,
    from: currentPeriodStart,
    to: now,
    window: '1h',
  });
  const usage = calculateAverageUsage(samples);
  const averageStorageTibUsed = usage.averageStorageBytesUsed / TIB_BYTES;

  console.log('[usage-worker] Usage calculated', {
    orgId,
    sampleCount: usage.sampleCount,
    averageStorageTibUsed,
  });

  if (averageStorageTibUsed > 0) {
    const stripe = getStripeClient();
    await stripe.billing.meterEvents.create({
      event_name: process.env.STRIPE_METER_EVENT_NAME ?? '',
      payload: {
        stripe_customer_id: stripeCustomerId,
        value: String(averageStorageTibUsed),
      },
      timestamp: Math.floor(Date.now() / 1000),
    });
    console.log('[usage-worker] Stripe meter event created', {
      stripeCustomerId,
      averageStorageTibUsed,
    });
  }

  // Write audit record
  const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60; // 90 days
  await dynamo.send(
    new PutItemCommand({
      TableName: Resource.BillingTable.name,
      Item: marshall({
        pk: `ORG#${orgId}`,
        sk: `USAGE_REPORT#${reportDate}`,
        orgId,
        subscriptionId,
        stripeCustomerId,
        currentPeriodStart,
        reportDate,
        averageStorageBytesUsed: usage.averageStorageBytesUsed,
        averageStorageTibUsed,
        sampleCount: usage.sampleCount,
        reportedToStripe: averageStorageTibUsed > 0,
        createdAt: new Date().toISOString(),
        ttl,
      }),
    }),
  );

  console.log('[usage-worker] Audit record written', { orgId, reportDate });
}
