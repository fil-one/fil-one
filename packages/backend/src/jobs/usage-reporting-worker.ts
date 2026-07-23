import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { getDynamoClient } from '../lib/ddb-client.js';
import { Resource } from 'sst';
import {
  GB_BYTES,
  TRIAL_STORAGE_LIMIT,
  TRIAL_EGRESS_LIMIT,
  formatBytes,
  TenantStatus,
} from '@filone/shared';
import {
  getCustomerExistence,
  getStripeClient,
  isStripeResourceMissing,
  updateCustomerMetadata,
} from '../lib/stripe-client.js';
import { closeOutDeletedCustomer } from '../lib/deleted-customer-cleanup.js';
import { emitStripeCustomersOutOfSync } from '../lib/usage-worker-metrics.js';
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
  /**
   * Key of the org's billing record (CUSTOMER#<userId>). Optional only for
   * payloads dispatched by a pre-upgrade orchestrator; without it the
   * deleted-customer reconciliation is skipped until the next daily run.
   */
  userId?: string;
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
    userId,
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

  const meterResult = await reportStorageToStripe({
    orgId,
    subscriptionId,
    stripeCustomerId,
    averageStorageGbUsed,
    meterEventName,
  });

  const { orgSyncAction, lockAction } = await resolveOrgSyncAndLockActions({
    orgId,
    userId,
    orgName,
    stripeCustomerId,
    isTrial,
    aggregate,
    meterCustomerMissing: meterResult.customerMissing,
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
    reportedToStripe: meterResult.reported,
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
 * Runs the org metadata sync, deleted-customer reconciliation, and trial-lock steps,
 * returning the audit actions. When Stripe reports the customer missing, the
 * reconciliation path replaces the normal steps; a customer verified alive
 * falls back to normal lock enforcement. Also emits the
 * StripeCustomersOutOfSync metric.
 */
async function resolveOrgSyncAndLockActions(params: {
  orgId: string;
  userId: string | undefined;
  orgName: string | undefined;
  stripeCustomerId: string;
  isTrial: boolean;
  aggregate: AggregateUsage;
  meterCustomerMissing: boolean;
}): Promise<{ orgSyncAction: string; lockAction: string }> {
  const { orgId, userId, orgName, stripeCustomerId, isTrial, aggregate } = params;

  let customerMissing = params.meterCustomerMissing;
  let orgSyncAction: string;
  if (customerMissing) {
    orgSyncAction = 'skipped:customer-missing';
  } else {
    const syncResult = await syncOrgMetadata({
      stripeCustomerId,
      orgName,
      currentStorageBytes: aggregate.currentStorageBytes,
    });
    orgSyncAction = syncResult.action;
    customerMissing = syncResult.customerMissing;
  }

  const enforceLocks = () =>
    resolveLockAction({
      isTrial,
      orgId,
      currentStorageBytes: aggregate.currentStorageBytes,
      totalEgressBytes: aggregate.totalEgressBytes,
    });

  if (!customerMissing) {
    emitStripeCustomersOutOfSync(0);
    return { orgSyncAction, lockAction: await enforceLocks() };
  }

  // The Stripe customer appears to be gone. Instead of the normal steps, try
  // to reconcile our state (billing record + tenant status) with Stripe's —
  // trial lock enforcement is moot for a tenant being disabled.
  const reconciliation = await reconcileDeletedCustomer({ orgId, userId, stripeCustomerId });
  emitStripeCustomersOutOfSync(reconciliation.outOfSync ? 1 : 0);
  // A null lockAction means the customer is alive (transient
  // resource_missing), so this run must still enforce trial locks normally.
  return {
    orgSyncAction: reconciliation.orgSyncAction,
    lockAction: reconciliation.lockAction ?? (await enforceLocks()),
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

async function reportStorageToStripe(params: {
  orgId: string;
  subscriptionId: string;
  stripeCustomerId: string;
  averageStorageGbUsed: number;
  meterEventName: string;
}): Promise<{ reported: boolean; customerMissing: boolean }> {
  const { orgId, subscriptionId, stripeCustomerId, averageStorageGbUsed, meterEventName } = params;
  if (averageStorageGbUsed <= 0) return { reported: false, customerMissing: false };

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
        code: (error as { code?: string }).code,
      });
      return { reported: false, customerMissing: true };
    }
    throw error;
  }
  console.log('[usage-worker] Stripe meter event created', {
    stripeCustomerId,
    averageStorageGbUsed,
  });
  return { reported: true, customerMissing: false };
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
}): Promise<{ action: string; customerMissing: boolean }> {
  if (!params.orgName && params.currentStorageBytes === 0) {
    return { action: 'skipped:nothing-to-sync', customerMissing: false };
  }
  try {
    const metadata: Record<string, string> = {
      [STRIPE_METADATA_KEYS.storageUsed]: formatBytes(params.currentStorageBytes),
    };
    if (params.orgName) metadata[STRIPE_METADATA_KEYS.organizationName] = params.orgName;
    await updateCustomerMetadata(params.stripeCustomerId, metadata);
    return { action: 'ok', customerMissing: false };
  } catch (error) {
    if (isStripeResourceMissing(error)) {
      console.warn('[usage-worker] Stripe customer missing — skipping org metadata sync', {
        stripeCustomerId: params.stripeCustomerId,
        code: (error as { code?: string }).code,
      });
      return { action: 'skipped:customer-missing', customerMissing: true };
    }
    console.error('[usage-worker] Failed to sync org metadata', {
      stripeCustomerId: params.stripeCustomerId,
      error,
    });
    return { action: `error:${(error as Error).message}`, customerMissing: false };
  }
}

/**
 * Reconciles our state with Stripe after a resource_missing signal: when the
 * customer is confirmed deleted, disables the tenant in every provisioned
 * region and marks the billing record canceled, taking the org out of future
 * usage-reporting runs. The getCustomerExistence verification is load-bearing:
 * a customer this account has never seen (plain 404 instead of a
 * deleted-stub) points at a key/account misconfiguration where blindly
 * reconciling would wrongly disable every tenant — refuse and alert instead.
 */
async function reconcileDeletedCustomer(params: {
  orgId: string;
  userId: string | undefined;
  stripeCustomerId: string;
}): Promise<{
  orgSyncAction: string;
  /** null → the customer turned out to be alive; run normal lock enforcement. */
  lockAction: string | null;
  /** true when the customer is still missing and its state was NOT reconciled this run. */
  outOfSync: boolean;
}> {
  const { orgId, userId, stripeCustomerId } = params;

  const existence = await getCustomerExistence(stripeCustomerId);
  if (existence === 'not-in-account') {
    console.error(
      '[usage-worker] Stripe customer not found in this account — refusing to reconcile; check the configured Stripe key/account',
      { orgId, userId, stripeCustomerId },
    );
    return {
      orgSyncAction: 'error:customer-not-in-account',
      lockAction: 'skipped:customer-missing',
      outOfSync: true,
    };
  }
  if (existence === 'exists') {
    // The resource_missing that got us here was transient/anomalous; the
    // customer is alive, so there is nothing to reconcile and nothing out of
    // sync.
    console.warn(
      '[usage-worker] Stripe reported the customer missing but it exists — skipping reconciliation',
      {
        orgId,
        userId,
        stripeCustomerId,
      },
    );
    return {
      orgSyncAction: 'error:customer-missing-but-exists',
      lockAction: null,
      outOfSync: false,
    };
  }

  if (!userId) {
    console.warn(
      '[usage-worker] Customer deleted but payload has no userId — reconciliation deferred to the next run',
      { orgId, stripeCustomerId },
    );
    return {
      orgSyncAction: 'error:reconcile-skipped-no-user-id',
      lockAction: 'skipped:customer-missing',
      outOfSync: true,
    };
  }

  const outcomes = await closeOutDeletedCustomer({ userId, orgId });
  const failed = outcomes.filter((o) => o.outcome === 'error');
  if (failed.length > 0) {
    // Record left non-canceled on purpose: tomorrow's run re-enters this path
    // and retries the failed regions.
    const failedRegions = failed.map((o) => o.orchestratorId).join(',');
    return {
      orgSyncAction: `reconcile-failed:${failedRegions}`,
      lockAction: `error:sync-failed:${failedRegions}`,
      outOfSync: true,
    };
  }

  console.log('[usage-worker] Reconciled deleted Stripe customer', {
    orgId,
    userId,
    stripeCustomerId,
    regions: outcomes.map((o) => ({ orchestratorId: o.orchestratorId, outcome: o.outcome })),
  });
  // The reconciliation disabled the tenant in every provisioned region.
  return { orgSyncAction: 'reconciled:customer-deleted', lockAction: 'disabled', outOfSync: false };
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
