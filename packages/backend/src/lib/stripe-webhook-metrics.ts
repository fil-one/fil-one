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
