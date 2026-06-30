import { type RagBucket } from '../lib/rag-bucket-api.js';

/**
 * Compact sync-status badge driven by the indexer telemetry (FIL-556). Renders
 * "Syncing…" while a reconciliation is in flight and "Sync failed" with the
 * reason (in the tooltip + visible text) on error. Returns null for the steady
 * `idle`/absent state, which the surrounding row already describes via the
 * files/size/last-synced line. Independent of enablement: a syncing/errored
 * bucket is still enabled and queryable.
 */
export function SyncStatusBadge({ bucket }: { bucket: RagBucket }) {
  if (bucket.syncState === 'syncing') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        Syncing…
      </span>
    );
  }
  if (bucket.syncState === 'error') {
    return (
      <span
        title={bucket.lastSyncError ?? 'Sync failed'}
        className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
        Sync failed
      </span>
    );
  }
  return null;
}
