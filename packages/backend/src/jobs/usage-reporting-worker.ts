import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { getDynamoClient } from '../lib/ddb-client.js';
import { Resource } from 'sst';
import { GB_BYTES, TRIAL_STORAGE_LIMIT, TRIAL_EGRESS_LIMIT } from '@filone/shared';
import { getStripeClient } from '../lib/stripe-client.js';
import {
  getStorageSamples,
  getOperationsSamples,
  getTenantInfo,
  updateTenantStatus,
} from '../lib/aurora-backoffice.js';
import type { ModelsTenantStatus } from '../lib/aurora-backoffice.js';
import { setOrgAuroraTenantStatus } from '../lib/org-profile.js';
import { calculateAverageUsage } from '../lib/usage-calculator.js';

const dynamo = getDynamoClient();

export interface UsageReportingWorkerPayload {
  orgId: string;
  auroraTenantId: string;
  subscriptionId: string;
  stripeCustomerId: string;
  currentPeriodStart: string;
  subscriptionStatus: string;
  reportDate: string;
}

async function enforceTenantLocks({
  tenantId,
  orgId,
  currentStatus,
  currentStorageBytes,
  totalEgressBytes,
}: {
  tenantId: string;
  orgId: string;
  currentStatus: ModelsTenantStatus | undefined;
  currentStorageBytes: number;
  totalEgressBytes: number;
}): Promise<ModelsTenantStatus> {
  // Determine desired status (DISABLED > WRITE_LOCKED > ACTIVE)
  let desiredStatus: ModelsTenantStatus;
  if (totalEgressBytes >= TRIAL_EGRESS_LIMIT) {
    desiredStatus = 'DISABLED';
  } else if (currentStorageBytes >= TRIAL_STORAGE_LIMIT) {
    desiredStatus = 'WRITE_LOCKED';
  } else {
    desiredStatus = 'ACTIVE';
  }

  if (desiredStatus !== currentStatus) {
    console.log('[usage-worker] Updating tenant status', {
      tenantId,
      from: currentStatus,
      to: desiredStatus,
      currentStorageBytes,
      totalEgressBytes,
    });
    await updateTenantStatus({ tenantId, status: desiredStatus });
    await setOrgAuroraTenantStatus(orgId, desiredStatus);
  }

  return desiredStatus;
}

// eslint-disable-next-line max-lines-per-function
export async function handler(event: UsageReportingWorkerPayload): Promise<void> {
  const {
    orgId,
    auroraTenantId,
    subscriptionId,
    stripeCustomerId,
    currentPeriodStart,
    subscriptionStatus,
    reportDate,
  } = event;

  console.log('[usage-worker] Processing', {
    orgId,
    subscriptionId,
    subscriptionStatus,
    reportDate,
  });

  const now = new Date().toISOString();
  const isTrial = subscriptionStatus === 'trialing';

  // Fetch storage, egress, and (for trials) tenant info in parallel
  const [storageSamples, operationsSamples, tenantInfo] = await Promise.all([
    getStorageSamples({
      tenantId: auroraTenantId,
      from: currentPeriodStart,
      to: now,
      window: '1h',
    }),
    getOperationsSamples({
      tenantId: auroraTenantId,
      from: currentPeriodStart,
      to: now,
      window: '24h',
    }),
    isTrial ? getTenantInfo({ tenantId: auroraTenantId }) : null,
  ]);

  const usage = calculateAverageUsage(storageSamples);
  const averageStorageGbUsed = usage.averageStorageBytesUsed / GB_BYTES;
  const currentStorageBytes = storageSamples.at(-1)?.bytesUsed ?? 0;
  const totalEgressBytes = operationsSamples.reduce(
    (sum, sample) => sum + (sample.txBytes ?? 0),
    0,
  );

  console.log('[usage-worker] Usage calculated', {
    orgId,
    sampleCount: usage.sampleCount,
    averageStorageGbUsed,
    currentStorageBytes,
    totalEgressBytes,
  });

  // Report metered usage to Stripe (in GB)
  if (averageStorageGbUsed > 0) {
    const stripe = getStripeClient();
    await stripe.billing.meterEvents.create({
      event_name: process.env.STRIPE_METER_EVENT_NAME ?? '',
      payload: {
        stripe_customer_id: stripeCustomerId,
        value: String(averageStorageGbUsed),
      },
      timestamp: Math.floor(Date.now() / 1000),
    });
    console.log('[usage-worker] Stripe meter event created', {
      stripeCustomerId,
      averageStorageGbUsed,
    });
  }

  // Enforce trial limits
  let lockAction: string | undefined;
  if (isTrial) {
    try {
      lockAction = await enforceTenantLocks({
        tenantId: auroraTenantId,
        orgId,
        currentStatus: tenantInfo!.status,
        currentStorageBytes,
        totalEgressBytes,
      });
    } catch (error) {
      lockAction = `error:${(error as Error).message}`;
      console.error('[usage-worker] Failed to enforce tenant locks', {
        orgId,
        error: (error as Error).message,
      });
    }
  } else {
    lockAction = 'skipped:paid';
  }

  // Write audit record
  const ttl = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60; // 365 days
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
        subscriptionStatus,
        reportDate,
        averageStorageBytesUsed: usage.averageStorageBytesUsed,
        averageStorageGbUsed,
        totalEgressBytes,
        sampleCount: usage.sampleCount,
        reportedToStripe: averageStorageGbUsed > 0,
        lockAction,
        createdAt: new Date().toISOString(),
        ttl,
      }),
    }),
  );

  console.log('[usage-worker] Audit record written', { orgId, reportDate });
}
