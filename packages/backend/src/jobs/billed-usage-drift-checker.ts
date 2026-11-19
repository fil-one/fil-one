import { GB_BYTES, SubscriptionStatus } from '@filone/shared';
import { reportMetric } from '../lib/metrics.ts';
import { isOrgDeletedOrDeleting } from '../lib/org-profile.ts';
import { getOrgAggregateUsage } from '../lib/org-usage-report.ts';
import { getStripeClient } from '../lib/stripe-client.ts';
import { METERED_SUBSCRIPTIONS, scanSubscriptions } from '../lib/subscription-store.ts';

const LOG = '[billed-usage-drift-checker]';

/** Only orgs invoicing within this window are checked: earlier gaps still self-heal. */
const INVOICE_WINDOW_MS = 48 * 60 * 60 * 1000;
/** A gap counts as drift only when it exceeds both limits. */
const TOLERANCE_PCT = 2;
const TOLERANCE_GB = 1;

interface MeteredOrg {
  pk: string;
  orgId: string;
  userId?: string;
  subscriptionId: string;
  stripeCustomerId: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
}

export interface UsageGap {
  gapGb: number;
  gapPct: number;
  drifted: boolean;
}

/** Compares the GB Stripe will invoice with the GB the org actually stored. */
export function measureUsageGap({
  billedGb,
  actualGb,
}: {
  billedGb: number;
  actualGb: number;
}): UsageGap {
  const gapGb = Math.abs(actualGb - billedGb);
  const larger = Math.max(actualGb, billedGb);
  const gapPct = larger > 0 ? (gapGb / larger) * 100 : 0;
  return {
    gapGb: round2(gapGb),
    gapPct: round2(gapPct),
    drifted: gapPct > TOLERANCE_PCT && gapGb > TOLERANCE_GB,
  };
}

/**
 * Read-only check that the storage Stripe will invoice matches the storage each
 * org used, run for orgs whose billing period ends within 48 hours. Emits one
 * summary metric per run and one `out_of_sync` log line per drifted org, which
 * the Grafana alert groups by org (docs/architectural-decisions/2026-11-billed-usage-drift.md).
 */
export async function handler(): Promise<void> {
  const meterEventName = process.env.STRIPE_METER_EVENT_NAME;
  if (!meterEventName) throw new Error('STRIPE_METER_EVENT_NAME env var is not set');

  const now = Date.now();
  let meterId: string;
  let orgs: MeteredOrg[];
  try {
    meterId = await getMeterId(meterEventName);
    orgs = await scanOrgsInvoicingSoon(now);
  } catch (error) {
    // The checker-failure alert watches BilledUsageProbeFailed, so a run that
    // cannot start must still report one.
    console.error(`${LOG} setup failed`, { error });
    emitRunSummary({ checked: 0, drift: 0, probeFailed: 1 });
    throw error;
  }
  const stats = { checked: 0, drift: 0, probeFailed: 0 };

  for (const org of orgs) {
    try {
      if (await isOrgDeletedOrDeleting(org.orgId)) continue;
      const { billedGb, actualGb } = await readBilledAndActual(org, meterId, now);
      stats.checked += 1;

      const gap = measureUsageGap({ billedGb, actualGb });
      if (!gap.drifted) continue;
      stats.drift += 1;
      // Production drops console.log, and the alert parses this line with LogQL's json
      // stage, which needs one JSON string rather than Node's printed object.
      console.warn(
        JSON.stringify({
          event: `${LOG} out_of_sync`,
          orgId: org.orgId,
          subscriptionId: org.subscriptionId,
          periodEnd: org.currentPeriodEnd,
          billedGb: round2(billedGb),
          actualGb: round2(actualGb),
          gapGb: gap.gapGb,
          gapPct: gap.gapPct,
        }),
      );
    } catch (error) {
      stats.probeFailed += 1;
      console.error(`${LOG} probe failed`, { orgId: org.orgId, error });
    }
  }

  emitRunSummary(stats);
  console.log(`${LOG} complete`, { candidates: orgs.length, ...stats });
}

async function getMeterId(eventName: string): Promise<string> {
  // shortcut: reads one page of 100 meters; paginate if the account ever holds more.
  const meters = await getStripeClient().billing.meters.list({ status: 'active', limit: 100 });
  const meter = meters.data.find((m) => m.event_name === eventName);
  if (!meter) throw new Error(`No active Stripe meter with event name ${eventName}`);
  return meter.id;
}

async function scanOrgsInvoicingSoon(now: number): Promise<MeteredOrg[]> {
  return scanSubscriptions<MeteredOrg>({
    job: 'billed-usage-drift-checker',
    ...METERED_SUBSCRIPTIONS,
    select: (record, owner) => {
      // Stripe does not charge usage during a trial, so a trial's gap never reaches an invoice.
      if (record.subscriptionStatus === SubscriptionStatus.Trialing) return undefined;
      const { stripeCustomerId, currentPeriodStart, currentPeriodEnd } = record;
      if (
        typeof stripeCustomerId !== 'string' ||
        typeof currentPeriodStart !== 'string' ||
        typeof currentPeriodEnd !== 'string'
      ) {
        console.warn(`${LOG} Missing billing period or customer, skipping`, {
          orgId: owner.orgId,
        });
        return undefined;
      }
      const msToEnd = Date.parse(currentPeriodEnd) - now;
      if (!(msToEnd > 0 && msToEnd <= INVOICE_WINDOW_MS)) return undefined;
      return {
        ...owner,
        subscriptionId: record.subscriptionId as string,
        stripeCustomerId,
        currentPeriodStart,
        currentPeriodEnd,
      };
    },
  });
}

async function readBilledAndActual(
  org: MeteredOrg,
  meterId: string,
  now: number,
): Promise<{ billedGb: number; actualGb: number }> {
  const [summaries, aggregate] = await Promise.all([
    getStripeClient().billing.meters.listEventSummaries(meterId, {
      customer: org.stripeCustomerId,
      start_time: toMinuteSeconds(Date.parse(org.currentPeriodStart)),
      end_time: toMinuteSeconds(now),
    }),
    getOrgAggregateUsage({
      orgId: org.orgId,
      from: org.currentPeriodStart,
      to: new Date(now).toISOString(),
    }),
  ]);
  // The meter keeps the last value reported in the period; no summary means nothing was reported.
  const billedGb = summaries.data[0]?.aggregated_value ?? 0;
  const actualGb = (aggregate?.averageStorageBytesUsed ?? 0) / GB_BYTES;
  return { billedGb, actualGb };
}

/** Stripe accepts meter summary bounds only on whole minutes. */
function toMinuteSeconds(ms: number): number {
  return Math.floor(ms / 60_000) * 60;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function emitRunSummary(stats: { checked: number; drift: number; probeFailed: number }): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [
            { Name: 'BilledUsageOrgsChecked', Unit: 'Count' },
            { Name: 'BilledUsageDrift', Unit: 'Count' },
            { Name: 'BilledUsageProbeFailed', Unit: 'Count' },
          ],
        },
      ],
    },
    BilledUsageOrgsChecked: stats.checked,
    BilledUsageDrift: stats.drift,
    BilledUsageProbeFailed: stats.probeFailed,
  });
}
