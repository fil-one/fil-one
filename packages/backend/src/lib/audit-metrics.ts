import { reportMetric } from './metrics.js';
import type { AuditQueryCost } from './audit-query.js';

/**
 * What an audit read cost, as EMF.
 *
 * The number worth watching is pages against rows. Latency degrades late and
 * obviously; a filtered query burning many pages to produce few rows is what
 * says an org has outgrown a single partition read, and it says so well before
 * anyone complains. No SLO yet, because there is no baseline to set one from.
 *
 * Dimensioned on the route alone. An org or actor id would be an unbounded
 * dimension, which is the mistake `authorize.ts` already avoids for its denial
 * counters.
 */
export function reportAuditQuery({
  route,
  cost,
  durationMs,
  rowsReturned,
}: {
  route: 'list' | 'export';
  cost: AuditQueryCost;
  durationMs: number;
  rowsReturned: number;
}): void {
  reportMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'FilOne',
          Dimensions: [['route']],
          Metrics: [
            { Name: 'AuditQueryDuration', Unit: 'Milliseconds' },
            { Name: 'AuditQueryPages', Unit: 'Count' },
            { Name: 'AuditQueryItemsRead', Unit: 'Count' },
            { Name: 'AuditQueryRowsReturned', Unit: 'Count' },
          ],
        },
      ],
    },
    route,
    AuditQueryDuration: durationMs,
    AuditQueryPages: cost.pages,
    AuditQueryItemsRead: cost.rows,
    AuditQueryRowsReturned: rowsReturned,
  });
}
