import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { getDynamoClient } from '../lib/ddb-client.js';
import { Resource } from 'sst';
import { GB_BYTES, TRIAL_STORAGE_LIMIT, TRIAL_EGRESS_LIMIT, formatBytes } from '@filone/shared';
import { getStripeClient, updateCustomerMetadata } from '../lib/stripe-client.js';
import {
  getStorageSamples,
  getOperationsSamples,
  getTenantInfo,
  updateTenantStatus,
} from '../lib/aurora/aurora-backoffice.js';
import type { ModelsTenantStatus } from '../lib/aurora/aurora-backoffice.js';
import { setOrgAuroraTenantStatus } from '../lib/org-profile.js';
import { STRIPE_METADATA_KEYS } from '../lib/stripe-metadata.js';
import { calculateAverageUsage } from '../lib/usage-calculator.js';

const dynamo = getDynamoClient();

export interface UsageReportingWorkerPayload {
  orgId: string;
  auroraTenantId: string;
  orgName?: string;
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

export async function handler(event: UsageReportingWorkerPayload): Promise<void> {
  const {
    orgId,
    auroraTenantId,
    orgName,
    subscriptionId,
    stripeCustomerId,
    currentPeriodStart,
    subscriptionStatus,
    reportDate,
  } = event;

  const meterEventName = process.env.STRIPE_METER_EVENT_NAME;
  if (!meterEventName) {
    throw new Error('STRIPE_METER_EVENT_NAME env var is not set');
  }

  const now = new Date().toISOString();
  const isTrial = subscriptionStatus === 'trialing';

  // Fetch storage, egress, and (for trials) tenant info in parallel
  let storageSamples: Awaited<ReturnType<typeof getStorageSamples>>;
  let operationsSamples: Awaited<ReturnType<typeof getOperationsSamples>>;
  let tenantInfo: Awaited<ReturnType<typeof getTenantInfo>> | null;
  try {
    [storageSamples, operationsSamples, tenantInfo] = await Promise.all([
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
  } catch (error) {
    const e = error as Error & { cause?: unknown };
    console.error('[usage-worker] Aurora fetch failed', {
      orgId,
      auroraTenantId,
      subscriptionId,
      message: e.message,
      cause: e.cause,
      stack: e.stack,
    });
    throw error;
  }

  const usage = calculateAverageUsage(storageSamples);
  const averageStorageGbUsed = usage.averageStorageBytesUsed / GB_BYTES;
  const currentStorageBytes = storageSamples.at(-1)?.bytesUsed ?? 0;
  const totalEgressBytes = operationsSamples.reduce(
    (sum, sample) => sum + (sample.txBytes ?? 0),
    0,
  );

  const { reported } = await reportStorageToStripe({
    orgId,
    subscriptionId,
    stripeCustomerId,
    averageStorageGbUsed,
    meterEventName,
  });

  const orgSyncAction = await syncOrgMetadata({
    stripeCustomerId,
    orgName,
    currentStorageBytes,
  });

  const lockAction = isTrial
    ? await safeEnforceTrialLocks({
        tenantId: auroraTenantId,
        orgId,
        currentStatus: tenantInfo!.status,
        currentStorageBytes,
        totalEgressBytes,
      })
    : 'skipped:paid';

  await writeUsageAuditRecord({
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
    lockAction,
    reportedToStripe: reported,
    orgSyncAction,
  });
}

// Stripe SDK errors expose `code` on the error object; matches StripeInvalidRequestError 404s.
const isStripeResourceMissing = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'resource_missing';

async function reportStorageToStripe(params: {
  orgId: string;
  subscriptionId: string;
  stripeCustomerId: string;
  averageStorageGbUsed: number;
  meterEventName: string;
}): Promise<{ reported: boolean }> {
  const { orgId, subscriptionId, stripeCustomerId, averageStorageGbUsed, meterEventName } = params;
  if (averageStorageGbUsed <= 0) return { reported: false };

  const stripe = getStripeClient();
  try {
    await stripe.billing.meterEvents.create({
      event_name: meterEventName,
      payload: {
        stripe_customer_id: stripeCustomerId,
        value: String(averageStorageGbUsed),
      },
      timestamp: Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    if (isStripeResourceMissing(error)) {
      console.warn('[usage-worker] Stripe customer missing — skipping meter event', {
        orgId,
        subscriptionId,
        stripeCustomerId,
        averageStorageGbUsed,
        code: 'resource_missing',
      });
      return { reported: false };
    }
    throw error;
  }
  console.log('[usage-worker] Stripe meter event created', {
    stripeCustomerId,
    averageStorageGbUsed,
  });
  return { reported: true };
}

async function safeEnforceTrialLocks(params: {
  tenantId: string;
  orgId: string;
  currentStatus: ModelsTenantStatus | undefined;
  currentStorageBytes: number;
  totalEgressBytes: number;
}): Promise<string> {
  try {
    return await enforceTenantLocks(params);
  } catch (error) {
    console.error('[usage-worker] Failed to enforce tenant locks', {
      orgId: params.orgId,
      error,
    });
    return `error:${(error as Error).message}`;
  }
}

async function syncOrgMetadata(params: {
  stripeCustomerId: string;
  orgName: string | undefined;
  currentStorageBytes: number;
}): Promise<string> {
  if (!params.orgName && params.currentStorageBytes === 0) return 'skipped:nothing-to-sync';
  try {
    const metadata: Record<string, string> = {
      [STRIPE_METADATA_KEYS.storageUsed]: formatBytes(params.currentStorageBytes),
    };
    if (params.orgName) metadata[STRIPE_METADATA_KEYS.organizationName] = params.orgName;
    await updateCustomerMetadata(params.stripeCustomerId, metadata);
    return 'ok';
  } catch (error) {
    console.error('[usage-worker] Failed to sync org metadata', {
      stripeCustomerId: params.stripeCustomerId,
      error,
    });
    return `error:${(error as Error).message}`;
  }
}

async function writeUsageAuditRecord(params: {
  orgId: string;
  subscriptionId: string;
  stripeCustomerId: string;
  currentPeriodStart: string;
  subscriptionStatus: string;
  reportDate: string;
  averageStorageBytesUsed: number;
  averageStorageGbUsed: number;
  totalEgressBytes: number;
  sampleCount: number;
  lockAction: string;
  reportedToStripe: boolean;
  orgSyncAction: string;
}): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60; // 365 days
  await dynamo.send(
    new PutItemCommand({
      TableName: Resource.BillingTable.name,
      Item: marshall({
        pk: `ORG#${params.orgId}`,
        sk: `USAGE_REPORT#${params.reportDate}`,
        orgId: params.orgId,
        subscriptionId: params.subscriptionId,
        stripeCustomerId: params.stripeCustomerId,
        currentPeriodStart: params.currentPeriodStart,
        subscriptionStatus: params.subscriptionStatus,
        reportDate: params.reportDate,
        averageStorageBytesUsed: params.averageStorageBytesUsed,
        averageStorageGbUsed: params.averageStorageGbUsed,
        totalEgressBytes: params.totalEgressBytes,
        sampleCount: params.sampleCount,
        reportedToStripe: params.reportedToStripe,
        lockAction: params.lockAction,
        orgSyncAction: params.orgSyncAction,
        createdAt: new Date().toISOString(),
        ttl,
      }),
    }),
  );
}
