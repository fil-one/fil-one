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
  /**
   * Billing records evaluated this run — a capped slice of the population, not
   * all of it. Read it with `truncated` or it says nothing about coverage.
   */
  total: number;
  /** Resolved to a HubSpot contact — already in sync, or written. */
  matched: number;
  /** Resolved to no HubSpot contact: "how many are we silently missing". */
  unmatched: number;
  /** HubSpot rejected or errored. When > 0, `unmatched` is an under-count. */
  writeFailed: number;
  /** Drift corrected — a standing count of dropped live writes. */
  repaired: number;
  /**
   * 1 when the run hit its per-run cap and left rows for the next one.
   *
   * The one number that tells a backlog draining from one that is not: every
   * other counter looks the same whether the job is converging or permanently
   * saturated. Alarm on it holding 1 across consecutive runs.
   */
  truncated: number;
  /**
   * Candidates whose profile row carried no address, so a contact HubSpot does
   * not already hold could not be bootstrapped. Without this the coverage of
   * the profile-row address is indistinguishable from HubSpot failing to match.
   */
  missingEmail: number;
  /** Candidates dropped for naming no user — no id to address a contact by. */
  missingUserId: number;
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
            { Name: 'HubSpotContactSyncTruncated', Unit: 'Count' },
            { Name: 'HubSpotContactMissingEmail', Unit: 'Count' },
            { Name: 'HubSpotContactMissingUserId', Unit: 'Count' },
          ],
        },
      ],
    },
    HubSpotContactSyncTotal: summary.total,
    HubSpotContactMatched: summary.matched,
    HubSpotContactUnmatched: summary.unmatched,
    HubSpotContactWriteFailed: summary.writeFailed,
    HubSpotContactRepaired: summary.repaired,
    HubSpotContactSyncTruncated: summary.truncated,
    HubSpotContactMissingEmail: summary.missingEmail,
    HubSpotContactMissingUserId: summary.missingUserId,
  });
}
