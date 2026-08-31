import { reportMetric } from './metrics.js';

export type DunningStage = 'entered' | 'retry' | 'recovered' | 'canceled';

function bucketAttempt(n: number | null | undefined): string {
  if (!n || n < 1) return 'unknown';
  if (n >= 4) return '4+';
  return String(n);
}

export function emitDunningEscalation(args: {
  stage: DunningStage;
  reason: string;
  attemptCount: number | null | undefined;
}): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['stage', 'reason', 'attemptBucket']],
          Metrics: [{ Name: 'DunningEscalation', Unit: 'Count' }],
        },
      ],
    },
    stage: args.stage,
    reason: args.reason,
    attemptBucket: bucketAttempt(args.attemptCount),
    DunningEscalation: 1,
  });
}

/**
 * A destructive billing write refused because the stored row names a different
 * Stripe object than the event in hand.
 *
 * Worth a counter rather than a log line alone: a steady rate means events are
 * arriving for subscriptions or customers the account has already replaced, and
 * that is the shape of a delivery problem nobody would otherwise see.
 */
export function emitSupersededBillingEvent(args: {
  /** The webhook event or job path that was about to write. */
  source: string;
  /** Which stored id disagreed with the event. */
  field: 'subscription' | 'customer';
}): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['source', 'field']],
          Metrics: [{ Name: 'SupersededBillingEvent', Unit: 'Count' }],
        },
      ],
    },
    source: args.source,
    field: args.field,
    SupersededBillingEvent: 1,
  });
}

export function emitInvoicePaid(): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [{ Name: 'InvoicePaid', Unit: 'Count' }],
        },
      ],
    },
    InvoicePaid: 1,
  });
}

export function emitInvoiceFinalized(): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [{ Name: 'InvoiceFinalized', Unit: 'Count' }],
        },
      ],
    },
    InvoiceFinalized: 1,
  });
}

export function emitInvoiceFinalizationFailed(reason: string): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['reason']],
          Metrics: [{ Name: 'InvoiceFinalizationFailed', Unit: 'Count' }],
        },
      ],
    },
    reason,
    InvoiceFinalizationFailed: 1,
  });
}

/**
 * A billing write that found no row to write to.
 *
 * Post-re-key there is one row per org and the writers assert it exists, so this
 * should be zero. A non-zero count means Stripe holds a customer the billing
 * table does not, which is a reconciliation job for a person rather than
 * something a retry can fix.
 */
export function emitBillingRowMissing(writer: string): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['writer']],
          Metrics: [{ Name: 'BillingRowMissing', Unit: 'Count' }],
        },
      ],
    },
    writer,
    BillingRowMissing: 1,
  });
}

/**
 * A trial claim refused because a pre-re-key `CUSTOMER#` row is still standing
 * for this user.
 *
 * Defense in depth for the flip-to-cleanup window: the backfill was verified,
 * but a row it missed would otherwise mint a second Stripe customer and
 * subscription for an account that already has one. Non-zero means the backfill
 * missed a cohort and the cleanup step must not run.
 */
export function emitTrialClaimBlockedByLegacyRow(): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [{ Name: 'TrialClaimBlockedByLegacyRow', Unit: 'Count' }],
        },
      ],
    },
    TrialClaimBlockedByLegacyRow: 1,
  });
}
