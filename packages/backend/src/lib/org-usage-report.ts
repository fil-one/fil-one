import { GB_BYTES } from '@filone/shared';
import { getProvisionedRegions } from './region-helpers.js';
import type { TenantUsageMetrics } from './service-orchestrator.js';
import { getStripeClient, isStripeResourceMissing } from './stripe-client.js';
import {
  calculateAverageUsage,
  mergeStorageSamples,
  sortStorageSamplesByTimestamp,
} from './usage-calculator.js';

const LOG = '[org-usage-report]';

export interface AggregateUsage {
  averageStorageBytesUsed: number;
  currentStorageBytes: number;
  totalEgressBytes: number;
  sampleCount: number;
}

export interface OrgUsageReport {
  reported: boolean;
  customerMissing: boolean;
  aggregate: AggregateUsage;
  averageStorageGbUsed: number;
}

/**
 * Meters an org's storage across its provisioned regions and submits it to
 * Stripe. Returns undefined when the org is provisioned nowhere.
 *
 * Two callers: the 12-hourly cron, and account teardown, which reports the
 * outstanding period before it cancels the subscription — a meter event after
 * cancellation lands on no invoice. Safe to repeat either way, since the meter
 * aggregates `last_during_period`: a re-driven pass submits the same or a fresher
 * absolute value rather than a delta.
 *
 * Deliberately excludes the lock enforcement, reconciliation and audit write the
 * cron does around it. Teardown must not enforce locks — it would fight its own
 * tenant disable over the status.
 */
export async function reportOrgUsage(params: {
  orgId: string;
  subscriptionId: string;
  stripeCustomerId: string;
  currentPeriodStart: string;
  to: string;
  meterEventName: string;
}): Promise<OrgUsageReport | undefined> {
  const { orgId, subscriptionId, stripeCustomerId, currentPeriodStart, to, meterEventName } =
    params;

  // Each region resolves its own tenant id (side-effect-free), is fetched
  // independently, then aggregated and reported at the org level.
  const orgRegions = await getProvisionedRegions(orgId);

  if (orgRegions.length === 0) {
    console.warn(`${LOG} Org not provisioned in any available region, skipping`, { orgId });
    return undefined;
  }

  let usageMetrics: TenantUsageMetrics[];
  try {
    usageMetrics = await Promise.all(
      orgRegions.map(async (t) => {
        try {
          return await t.orchestrator.getTenantUsageMetrics(t.tenantId, {
            from: currentPeriodStart,
            to,
            interval: '1d',
          });
        } catch (error) {
          // Attach the failing region/tenant to the error itself — Promise.all
          // only surfaces an index, and the escaping error is what the runtime
          // logs (enumerable own properties included).
          if (error instanceof Error) {
            Object.assign(error, { orgId, region: t.orchestrator.region, tenantId: t.tenantId });
          }
          throw error;
        }
      }),
    );
  } catch (error) {
    const e = error as Error & { cause?: unknown };
    console.error(`${LOG} Usage metrics fetch failed`, {
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

  return { ...meterResult, aggregate, averageStorageGbUsed };
}

/**
 * Aggregates per-region data into org-level totals. The storage average is
 * computed by merging the regions' time series (carrying forward each region's
 * last value) and averaging once — summing per-region means skews billing when
 * series are misaligned.
 */
export function aggregateUsageMetrics(usageMetrics: TenantUsageMetrics[]): AggregateUsage {
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
      console.warn(`${LOG} Stripe customer missing — skipping meter event`, {
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
  console.log(`${LOG} Stripe meter event created`, {
    stripeCustomerId,
    averageStorageGbUsed,
  });
  return { reported: true, customerMissing: false };
}
