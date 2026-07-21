import { reportMetric } from './metrics.js';

/**
 * Gauge-style out-of-sync signal: every usage-worker run emits 1 when it
 * found the org's Stripe customer missing and did NOT finish healing it, and
 * 0 otherwise (including runs that healed successfully — the state is back in
 * sync by the end of the run). Each org is dispatched once per daily
 * orchestrator run, so Sum over a 1-day period equals the number of customers
 * currently out of sync. Alarm on >= 1 for two consecutive daily periods so
 * single-day blips never fire (see
 * docs/plans/2026-07-stripe-deleted-customer-self-healing.md).
 */
export function emitStripeCustomersOutOfSync(value: 0 | 1): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [{ Name: 'StripeCustomersOutOfSync', Unit: 'Count' }],
        },
      ],
    },
    StripeCustomersOutOfSync: value,
  });
}
