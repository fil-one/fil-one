import { useState } from 'react';

import { formatBytes } from '@filone/shared';

import { Alert } from '../components/Alert.js';
import { BucketActionMenu } from '../components/BucketActionMenu.js';
import { BucketDrawer } from '../components/BucketDrawer.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { Heading } from '../components/Heading/Heading.js';
import { Spinner } from '../components/Spinner.js';
import { ToggleConfirmModal } from '../components/ToggleConfirmModal.js';
import { bucketKey, type RagBucket } from '../lib/rag-bucket-api.js';
import { timeAgo } from '../lib/time.js';

export { bucketKey } from '../lib/rag-bucket-api.js';
export type { RagBucket } from '../lib/rag-bucket-api.js';

// ---------------------------------------------------------------------------
// BucketRow
// ---------------------------------------------------------------------------

/** The files-indexed · index-size · last-synced line for a steadily-synced bucket. */
function BucketSyncedStats({ bucket }: { bucket: RagBucket }) {
  return (
    <>
      <span data-testid="bucket-row-stat-files" className="text-zinc-500">
        {bucket.filesIndexed.toLocaleString()}
      </span>
      {' files indexed'}
      <span aria-hidden="true"> · </span>
      <span data-testid="bucket-row-stat-size" className="text-zinc-500">
        {formatBytes(bucket.indexSize)}
      </span>
      <span aria-hidden="true"> · </span>
      {bucket.lastSyncedAt ? (
        <>
          {'Last synced '}
          <span data-testid="bucket-row-stat-synced" className="text-zinc-500">
            {timeAgo(bucket.lastSyncedAt)}
          </span>
        </>
      ) : (
        'Not yet synced'
      )}
    </>
  );
}

/**
 * The coarse state driving the row description, exposed via `data-sync-state` so
 * E2E can assert status without matching on human labels like "Syncing…".
 * Note: the steady state includes both synced and never-synced (no `lastSyncedAt`) buckets.
 */
function bucketRowSyncState(bucket: RagBucket): 'not-indexed' | 'syncing' | 'error' | 'synced' {
  if (!bucket.enabled) return 'not-indexed';
  if (bucket.syncState === 'syncing') return 'syncing';
  if (bucket.syncState === 'error') return 'error';
  return 'synced';
}

/**
 * The row's one-line description. Enablement (`enabled`) decides "Not indexed";
 * the indexer sync progress (FIL-556) then layers the in-flight/failed indicator
 * WITHOUT changing whether the bucket is enabled: an enabled bucket mid-run
 * shows "Syncing…"; a failed run shows "Sync failed" + the reason; otherwise the
 * files/size/last-synced stats (with a "Not yet synced" fallback before the
 * first run).
 */
function BucketRowDescription({ bucket }: { bucket: RagBucket }) {
  if (!bucket.enabled) return <>Not indexed</>;
  if (bucket.syncState === 'syncing') return <span className="text-amber-600">Syncing…</span>;
  if (bucket.syncState === 'error') {
    return (
      <span className="text-red-600">
        Sync failed{bucket.lastSyncError ? `: ${bucket.lastSyncError}` : ''}
      </span>
    );
  }
  return <BucketSyncedStats bucket={bucket} />;
}

function BucketRow({
  bucket,
  pending,
  onToggle,
  onAsk,
}: {
  bucket: RagBucket;
  pending: boolean;
  onToggle: () => void;
  onAsk: () => void;
}) {
  return (
    <Card
      data-testid={`bucket-row-${bucketKey(bucket)}`}
      data-bucket-name={bucket.name}
      padding="none"
      className="overflow-hidden"
    >
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-3">
          <span
            className={`h-2 w-2 flex-shrink-0 rounded-full ${bucket.enabled ? 'bg-green-500' : 'bg-zinc-300'}`}
          />
          <div>
            <p data-testid="bucket-row-name" className="text-sm font-medium text-zinc-800">
              {bucket.name}
            </p>
            <p
              data-testid="bucket-row-status"
              data-sync-state={bucketRowSyncState(bucket)}
              className="text-xs text-zinc-400"
            >
              <BucketRowDescription bucket={bucket} />
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {bucket.enabled ? (
            <>
              <Button data-testid="bucket-row-ask" variant="ghost" size="sm" onClick={onAsk}>
                Ask questions
              </Button>
              <BucketActionMenu onDisable={onToggle} />
            </>
          ) : (
            <Button
              data-testid="bucket-row-index"
              variant="primary"
              size="sm"
              disabled={pending}
              onClick={onToggle}
            >
              {pending ? 'Enabling…' : 'Index'}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// BucketsTab
// ---------------------------------------------------------------------------

export function BucketsTab({
  buckets,
  isLoading,
  isError,
  errorMessage,
  togglingBucket,
  onConfirmToggle,
}: {
  buckets: RagBucket[];
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | undefined;
  togglingBucket: string | null;
  onConfirmToggle: (bucket: RagBucket) => void;
}) {
  const [confirm, setConfirm] = useState<RagBucket | null>(null);
  const [activeDrawer, setActiveDrawer] = useState<string | null>(null);
  const activeBucket = buckets.find((b) => bucketKey(b) === activeDrawer) ?? null;

  return (
    <section data-testid="buckets-tab" className="space-y-6">
      <Heading
        tag="h2"
        size="lg"
        description="Manage which buckets are indexed and available for querying."
      >
        Buckets
      </Heading>
      {isError ? (
        <div data-testid="buckets-error">
          <Alert variant="red" description={errorMessage ?? 'Failed to load buckets'} />
        </div>
      ) : isLoading ? (
        <div data-testid="buckets-loading" className="flex items-center justify-center py-12">
          <Spinner ariaLabel="Loading buckets" size={28} />
        </div>
      ) : buckets.length === 0 ? (
        <div data-testid="buckets-empty">
          <Alert variant="grey" description="You don't have any buckets yet." />
        </div>
      ) : (
        <div data-testid="buckets-list" className="space-y-3">
          {buckets.map((b) => (
            <BucketRow
              key={bucketKey(b)}
              bucket={b}
              pending={togglingBucket === bucketKey(b)}
              onToggle={() => setConfirm(b)}
              onAsk={() => setActiveDrawer(bucketKey(b))}
            />
          ))}
        </div>
      )}

      {activeBucket && activeBucket.enabled && (
        <BucketDrawer bucket={activeBucket} onClose={() => setActiveDrawer(null)} />
      )}

      <ToggleConfirmModal
        enabled={confirm?.enabled ?? false}
        pending={confirm != null && togglingBucket === bucketKey(confirm)}
        open={confirm != null}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) onConfirmToggle(confirm);
          setConfirm(null);
        }}
      />
    </section>
  );
}
