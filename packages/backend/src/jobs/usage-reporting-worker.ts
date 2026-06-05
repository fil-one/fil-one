import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { getDynamoClient } from '../lib/ddb-client.js';
import { Resource } from 'sst';
import { GB_BYTES, TRIAL_STORAGE_LIMIT, TRIAL_EGRESS_LIMIT, formatBytes } from '@filone/shared';
import { getStripeClient, updateCustomerMetadata } from '../lib/stripe-client.js';
import { getTenantInfo, updateTenantStatus } from '../lib/aurora/aurora-backoffice.js';
import type { ModelsTenantStatus } from '../lib/aurora/aurora-backoffice.js';
import { STRIPE_METADATA_KEYS } from '../lib/stripe-metadata.js';
import {
  calculateAverageUsage,
  mergeStorageSamples,
  sortStorageSamplesByTimestamp,
} from '../lib/usage-calculator.js';
import type { ServiceOrchestrator, TenantUsageMetrics } from '../lib/service-orchestrator.js';
import { getAvailableOrchestrators } from '../lib/service-orchestrator-registry.js';
import { auroraOrchestrator } from '../lib/aurora/aurora-orchestrator.js';

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

interface ReadyRegion {
  orchestrator: ServiceOrchestrator;
  tenantId: string;
}

/**
 * Resolves which stage-available regions the org is provisioned in. Asks each
 * orchestrator for the current stage to resolve its tenant id (side-effect-free
 * read), dropping any region where the tenant is not ready.
 */
async function resolveReadyRegions(orgId: string): Promise<ReadyRegion[]> {
  const orchestrators = getAvailableOrchestrators(process.env.FILONE_STAGE!);
  const resolved = await Promise.all(
    orchestrators.map(async (orchestrator) => {
      const tenantId = await orchestrator.isTenantReady(orgId);
      return tenantId ? { orchestrator, tenantId } : null;
    }),
  );
  return resolved.filter((r): r is ReadyRegion => r !== null);
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
  const orgRegions = await resolveReadyRegions(orgId);

  if (orgRegions.length === 0) {
    console.warn('[usage-worker] Org not provisioned in any available region, skipping', { orgId });
    return;
  }

  // Trial lock enforcement is Aurora-only; identify its tenant id (if any).
  const auroraTenantId = orgRegions.find(
    (r) => r.orchestrator.id === auroraOrchestrator.id,
  )?.tenantId;

  let usageMetrics: TenantUsageMetrics[];
  let auroraTenantInfo: Awaited<ReturnType<typeof getTenantInfo>> | null;
  try {
    [usageMetrics, auroraTenantInfo] = await Promise.all([
      Promise.all(
        orgRegions.map((t) =>
          t.orchestrator.getTenantUsageMetrics(t.tenantId, {
            from: currentPeriodStart,
            to: now,
            interval: '1d',
          }),
        ),
      ),
      isTrial && auroraTenantId ? getTenantInfo({ tenantId: auroraTenantId }) : null,
    ]);
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
    auroraTenantId,
    orgId,
    currentStatus: auroraTenantInfo?.status,
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
