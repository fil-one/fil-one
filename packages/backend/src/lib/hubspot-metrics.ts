import { reportMetric } from './metrics.js';

/**
 * The webhook write is best-effort, so this is the only immediate signal that a
 * status change did not propagate.
 */
export function emitHubSpotLiveWriteFailed(reason: string): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['reason']],
          Metrics: [{ Name: 'HubSpotLiveWriteFailed', Unit: 'Count' }],
        },
      ],
    },
    reason,
    HubSpotLiveWriteFailed: 1,
  });
}

export interface ContactSyncSummary {
  /** Billing records evaluated this run. */
  total: number;
  /** Resolved to a HubSpot contact — already in sync, or written. */
  matched: number;
  /** Resolved to no HubSpot contact: "how many are we silently missing". */
  unmatched: number;
  /** HubSpot rejected or errored. When > 0, `unmatched` is an under-count. */
  writeFailed: number;
  /** Drift corrected — a standing count of dropped live writes. */
  repaired: number;
}

/**
 * One datapoint per run, no dimensions — contact counts are unbounded and would
 * blow up Grafana cardinality. Per-entity triage goes to Loki via the
 * `[hubspot-contact-sync]` log lines.
 */
export function emitContactSyncSummary(summary: ContactSyncSummary): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [[]],
          Metrics: [
            { Name: 'HubSpotContactSyncTotal', Unit: 'Count' },
            { Name: 'HubSpotContactMatched', Unit: 'Count' },
            { Name: 'HubSpotContactUnmatched', Unit: 'Count' },
            { Name: 'HubSpotContactWriteFailed', Unit: 'Count' },
            { Name: 'HubSpotContactRepaired', Unit: 'Count' },
          ],
        },
      ],
    },
    HubSpotContactSyncTotal: summary.total,
    HubSpotContactMatched: summary.matched,
    HubSpotContactUnmatched: summary.unmatched,
    HubSpotContactWriteFailed: summary.writeFailed,
    HubSpotContactRepaired: summary.repaired,
  });
}
