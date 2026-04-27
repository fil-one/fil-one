import { reportMetric } from './metrics.js';

export type DunningStage = 'entered' | 'retry' | 'recovered' | 'canceled';

export function bucketAttempt(n: number | null | undefined): string {
  if (!n || n < 1) return 'unknown';
  if (n >= 4) return '4+';
  return String(n);
}

export function emitDunningEscalation(args: {
  stage: DunningStage;
  reason: string;
  attemptBucket: string;
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
    attemptBucket: args.attemptBucket,
    DunningEscalation: 1,
  });
}
