import { reportMetric } from './metrics.ts';

/**
 * A grace period ran out while Stripe still bills the subscription behind it.
 *
 * The enforcer leaves such an org alone rather than disable a customer who may
 * be paying, so any count here is a row that disagrees with Stripe and needs a
 * person to reconcile it.
 */
export function emitGraceExpiredWithLiveSubscription(status: string): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['status']],
          Metrics: [{ Name: 'GraceExpiredWithLiveSubscription', Unit: 'Count' }],
        },
      ],
    },
    status,
    GraceExpiredWithLiveSubscription: 1,
  });
}
