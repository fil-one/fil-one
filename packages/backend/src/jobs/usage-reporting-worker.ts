import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { getDynamoClient } from '../lib/ddb-client.js';
import { Resource } from 'sst';
import {
  GB_BYTES,
  TRIAL_STORAGE_LIMIT,
  TRIAL_EGRESS_LIMIT,
  formatBytes,
  S3Region,
} from '@filone/shared';
import { getStripeClient, updateCustomerMetadata } from '../lib/stripe-client.js';
import { getTenantInfo, updateTenantStatus } from '../lib/aurora/aurora-backoffice.js';
import type { ModelsTenantStatus } from '../lib/aurora/aurora-backoffice.js';
import { getOrchestratorForRegion } from '../lib/service-orchestrator-registry.js';
import { STRIPE_METADATA_KEYS } from '../lib/stripe-metadata.js';
import { calculateAverageUsage } from '../lib/usage-calculator.js';

const dynamo = getDynamoClient();

export interface UsageReportingWorkerPayload {
  orgId: string;
  /** Tenant ids per provisioned region. At least one must be present. */
  auroraTenantId?: string;
  fthTenantId?: string;
  orgName?: string;
  subscriptionId: string;
  stripeCustomerId: string;
  currentPeriodStart: string;
  subscriptionStatus: string;
  reportDate: string;
}

interface RegionUsage {
  region: S3Region;
  tenantId: string;
  averageStorageBytesUsed: number;
  currentStorageBytes: number;
  totalEgressBytes: number;
  sampleCount: number;
}

interface AggregateUsage {
  averageStorageBytesUsed: number;
  currentStorageBytes: number;
  totalEgressBytes: number;
  sampleCount: number;
}

async function enforceTenantLocks({
  tenantId,
  currentStatus,
  currentStorageBytes,
  totalEgressBytes,
}: {
  tenantId: string;
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
  }

  return desiredStatus;
}

export async function handler(event: UsageReportingWorkerPayload): Promise<void> {
  const {
    orgId,
    auroraTenantId,
    fthTenantId,
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

  // Each region the org is provisioned in is reported independently, then
  // aggregated for the org-level billing surface (Stripe meter + metadata + audit).
  const tenantRegions: { region: S3Region; tenantId: string }[] = [];
  if (auroraTenantId) tenantRegions.push({ region: S3Region.EuWest1, tenantId: auroraTenantId });
  if (fthTenantId) tenantRegions.push({ region: S3Region.UsEast1, tenantId: fthTenantId });

  // Trial lock enforcement is Aurora-only; fetch its tenant info alongside metrics.
  let regionUsages: RegionUsage[];
  let tenantRegionInfo: Awaited<ReturnType<typeof getTenantInfo>> | null;
  try {
    [regionUsages, tenantRegionInfo] = await Promise.all([
      Promise.all(tenantRegions.map((t) => fetchRegionUsage(t, currentPeriodStart, now))),
      isTrial && auroraTenantId ? getTenantInfo({ tenantId: auroraTenantId }) : null,
    ]);
  } catch (error) {
    const e = error as Error & { cause?: unknown };
    console.error('[usage-worker] Usage metrics fetch failed', {
      orgId,
      auroraTenantId,
      fthTenantId,
      subscriptionId,
      message: e.message,
      cause: e.cause,
      stack: e.stack,
    });
    throw error;
  }

  const aggregate = aggregateUsage(regionUsages);
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
    auroraTenantId,
    orgId,
    currentStatus: tenantRegionInfo?.status,
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
    regionUsages,
  });
}

/**
 * Fetches one region's usage via its orchestrator and reduces the normalized
 * time series to the per-region scalars the billing surface needs.
 */
async function fetchRegionUsage(
  tenant: { region: S3Region; tenantId: string },
  from: string,
  to: string,
): Promise<RegionUsage> {
  const orchestrator = getOrchestratorForRegion(tenant.region);
  const metrics = await orchestrator.getTenantUsageMetrics(tenant.tenantId, {
    from,
    to,
    interval: '1h',
  });
  const usage = calculateAverageUsage(metrics.storage);
  return {
    region: tenant.region,
    tenantId: tenant.tenantId,
    averageStorageBytesUsed: usage.averageStorageBytesUsed,
    currentStorageBytes: metrics.storage.at(-1)?.bytesUsed ?? 0,
    totalEgressBytes: metrics.egress.reduce((sum, sample) => sum + (sample.bytesUsed ?? 0), 0),
    sampleCount: usage.sampleCount,
  };
}

function aggregateUsage(perRegion: RegionUsage[]): AggregateUsage {
  return perRegion.reduce<AggregateUsage>(
    (acc, u) => ({
      averageStorageBytesUsed: acc.averageStorageBytesUsed + u.averageStorageBytesUsed,
      currentStorageBytes: acc.currentStorageBytes + u.currentStorageBytes,
      totalEgressBytes: acc.totalEgressBytes + u.totalEgressBytes,
      sampleCount: acc.sampleCount + u.sampleCount,
    }),
    { averageStorageBytesUsed: 0, currentStorageBytes: 0, totalEgressBytes: 0, sampleCount: 0 },
  );
}

/**
 * Trial lock enforcement requires the Aurora control plane (status read +
 * write). Other regions have no equivalent lock mechanism wired yet, so they
 * are reported but not enforced.
 */
async function resolveLockAction(params: {
  isTrial: boolean;
  auroraTenantId: string | undefined;
  orgId: string;
  currentStatus: ModelsTenantStatus | undefined;
  currentStorageBytes: number;
  totalEgressBytes: number;
}): Promise<string> {
  if (!params.isTrial) return 'skipped:paid';
  if (!params.auroraTenantId) return 'skipped:region-unsupported';
  return safeEnforceTrialLocks({
    tenantId: params.auroraTenantId,
    orgId: params.orgId,
    currentStatus: params.currentStatus,
    currentStorageBytes: params.currentStorageBytes,
    totalEgressBytes: params.totalEgressBytes,
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
  regionUsages: RegionUsage[];
}): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60; // 365 days
  await dynamo.send(
    new PutItemCommand({
      TableName: Resource.BillingTable.name,
      Item: marshall(
        {
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
          // Per-region breakdown behind the aggregate totals above.
          regions: params.regionUsages,
          createdAt: new Date().toISOString(),
          ttl,
        },
        { removeUndefinedValues: true },
      ),
    }),
  );
}
