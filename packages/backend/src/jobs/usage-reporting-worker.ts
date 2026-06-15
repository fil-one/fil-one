import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { getDynamoClient } from '../lib/ddb-client.js';
import { Resource } from 'sst';
import { GB_BYTES, TRIAL_STORAGE_LIMIT, TRIAL_EGRESS_LIMIT, formatBytes } from '@filone/shared';
import { getStripeClient, updateCustomerMetadata } from '../lib/stripe-client.js';
import type { TenantStatus } from '../lib/service-orchestrator.js';
import { STRIPE_METADATA_KEYS } from '../lib/stripe-metadata.js';
import {
  calculateAverageUsage,
  mergeStorageSamples,
  sortStorageSamplesByTimestamp,
} from '../lib/usage-calculator.js';
import type { TenantUsageMetrics } from '../lib/service-orchestrator.js';
import {
  getProvisionedRegions,
  syncTenantStatusInProvisionedRegions,
} from '../lib/region-helpers.js';

const dynamo = getDynamoClient();

export interface UsageReportingWorkerPayload {
  orgId: string;
  orgName?: string;
  subscriptionId: string;
  stripeCustomerId: string;
  currentPeriodStart: string;
  subscriptionStatus: string;
  reportDate: string;
}

interface AggregateUsage {
  averageStorageBytesUsed: number;
  currentStorageBytes: number;
  totalEgressBytes: number;
  sampleCount: number;
}

async function enforceTenantLocks({
  orgId,
  currentStorageBytes,
  totalEgressBytes,
}: {
  orgId: string;
  currentStorageBytes: number;
  totalEgressBytes: number;
}): Promise<string> {
  // Determine desired status (disabled > write-locked > active).
  let desired: TenantStatus;
  if (totalEgressBytes >= TRIAL_EGRESS_LIMIT) {
    desired = 'disabled';
  } else if (currentStorageBytes >= TRIAL_STORAGE_LIMIT) {
    desired = 'write-locked';
  } else {
    desired = 'active';
  }

  const outcomes = await syncTenantStatusInProvisionedRegions(orgId, desired);

  const updated = outcomes.filter((o) => o.outcome === 'updated');
  if (updated.length > 0) {
    console.log('[usage-worker] Updated tenant status', {
      orgId,
      to: desired,
      regions: updated.map((o) => o.orchestratorId),
      currentStorageBytes,
      totalEgressBytes,
    });
  }

  const failed = outcomes.filter((o) => o.outcome === 'error');
  if (failed.length > 0) {
    // Per-region details were already logged by the sync helper. A failed
    // region still differs from the desired status, so the next run retries it.
    return `error:sync-failed:${failed.map((o) => o.orchestratorId).join(',')}`;
  }

  return desired;
}

export async function handler(event: UsageReportingWorkerPayload): Promise<void> {
  const {
    orgId,
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

  // Resolve which regions this org is provisioned in by asking each
  // stage-available orchestrator to resolve its tenant id (side-effect-free).
  // Each region is then fetched independently, aggregated, and reported on the
  // org-level.
  const orgRegions = await getProvisionedRegions(orgId);

  if (orgRegions.length === 0) {
    console.warn('[usage-worker] Org not provisioned in any available region, skipping', { orgId });
    return;
  }

  let usageMetrics: TenantUsageMetrics[];
  try {
    usageMetrics = await Promise.all(
      orgRegions.map((t) =>
        t.orchestrator.getTenantUsageMetrics(t.tenantId, {
          from: currentPeriodStart,
          to: now,
          interval: '1d',
        }),
      ),
    );
  } catch (error) {
    const e = error as Error & { cause?: unknown };
    console.error('[usage-worker] Usage metrics fetch failed', {
      orgId,
      regions: orgRegions.map((r) => ({ region: r.orchestrator.region, tenantId: r.tenantId })),
      subscriptionId,
      message: e.message,
      cause: e.cause,
      stack: e.stack,
    });
    throw error;
  }

  const aggregate = aggregateUsageMetrics(usageMetrics);
  const averageStorageGbUsed = aggregate.averageStorageBytesUsed / GB_BYTES;

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
    currentStorageBytes: aggregate.currentStorageBytes,
  });

  const lockAction = await resolveLockAction({
    isTrial,
    orgId,
    currentStorageBytes: aggregate.currentStorageBytes,
    totalEgressBytes: aggregate.totalEgressBytes,
  });

  await writeUsageAuditRecord({
    orgId,
    subscriptionId,
    stripeCustomerId,
    currentPeriodStart,
    subscriptionStatus,
    reportDate,
    averageStorageBytesUsed: aggregate.averageStorageBytesUsed,
    averageStorageGbUsed,
    totalEgressBytes: aggregate.totalEgressBytes,
    sampleCount: aggregate.sampleCount,
    lockAction,
    reportedToStripe: reported,
    orgSyncAction,
  });
}

/**
 * Aggregates per-region data into org-level totals. The storage average is
 * computed by merging the regions' time series (carrying forward each region's
 * last value) and averaging once — summing per-region means skews billing when
 * series are misaligned.
 */
function aggregateUsageMetrics(usageMetrics: TenantUsageMetrics[]): AggregateUsage {
  const sortedStorageMetrics = usageMetrics.map((r) => sortStorageSamplesByTimestamp(r.storage));
  const averageUsage = calculateAverageUsage(mergeStorageSamples(sortedStorageMetrics));
  const currentStorageBytes = sortedStorageMetrics.reduce(
    (sum, r) => sum + (r.at(-1)?.bytesUsed ?? 0),
    0,
  );
  const totalEgressBytes = usageMetrics.reduce(
    (sum, r) => sum + r.egress.reduce((s, e) => s + (e.bytesUsed ?? 0), 0),
    0,
  );
  return {
    averageStorageBytesUsed: averageUsage.averageStorageBytesUsed,
    currentStorageBytes,
    totalEgressBytes,
    // Number of distinct timestamps the org-level average is computed over.
    sampleCount: averageUsage.sampleCount,
  };
}

/**
 * Trial lock enforcement applies to every provisioned region. Each region's
 * live status is probed via its own orchestrator and reconciled with the
 * desired status (syncTenantStatusInProvisionedRegions), so partial failures
 * self-heal on the next run.
 */
async function resolveLockAction(params: {
  isTrial: boolean;
  orgId: string;
  currentStorageBytes: number;
  totalEgressBytes: number;
}): Promise<string> {
  if (!params.isTrial) return 'skipped:paid';
  return safeEnforceTrialLocks(params);
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
  orgId: string;
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
