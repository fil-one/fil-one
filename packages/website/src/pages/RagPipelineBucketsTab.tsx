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
import { type RagBucket } from '../lib/rag-bucket-api.js';
import { timeAgo } from '../lib/time.js';

export type { RagBucket } from '../lib/rag-bucket-api.js';

// ---------------------------------------------------------------------------
// BucketRow
// ---------------------------------------------------------------------------

/** The files-indexed · index-size · last-synced line for a steadily-synced bucket. */
function BucketSyncedStats({ bucket }: { bucket: RagBucket }) {
  return (
    <>
      <span className="text-zinc-500">{bucket.filesIndexed.toLocaleString()}</span>
      {' files indexed'}
      <span aria-hidden="true"> · </span>
      <span className="text-zinc-500">{formatBytes(bucket.indexSize)}</span>
      <span aria-hidden="true"> · </span>
      {bucket.lastSyncedAt ? (
        <>
          {'Last synced '}
          <span className="text-zinc-500">{timeAgo(bucket.lastSyncedAt)}</span>
        </>
      ) : (
        'Not yet synced'
      )}
    </>
  );
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
    <Card padding="none" className="overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-3">
          <span
            className={`h-2 w-2 flex-shrink-0 rounded-full ${bucket.enabled ? 'bg-green-500' : 'bg-zinc-300'}`}
          />
          <div>
            <p className="text-sm font-medium text-zinc-800">{bucket.name}</p>
            <p className="text-xs text-zinc-400">
              <BucketRowDescription bucket={bucket} />
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {bucket.enabled ? (
            <>
              <Button variant="ghost" size="sm" onClick={onAsk}>
                Ask questions
              </Button>
              <BucketActionMenu onDisable={onToggle} />
            </>
          ) : (
            <Button variant="primary" size="sm" disabled={pending} onClick={onToggle}>
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
  const activeBucket = buckets.find((b) => b.name === activeDrawer) ?? null;

  return (
    <section className="space-y-6">
      <Heading
        tag="h2"
        size="lg"
        description="Manage which buckets are indexed and available for querying."
      >
        Buckets
      </Heading>
      {isError ? (
        <Alert variant="red" description={errorMessage ?? 'Failed to load buckets'} />
      ) : isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner ariaLabel="Loading buckets" size={28} />
        </div>
      ) : buckets.length === 0 ? (
        <Alert variant="grey" description="You don't have any buckets yet." />
      ) : (
        <div className="space-y-3">
          {buckets.map((b) => (
            <BucketRow
              key={b.name}
              bucket={b}
              pending={togglingBucket === b.name}
              onToggle={() => setConfirm(b)}
              onAsk={() => setActiveDrawer(b.name)}
            />
          ))}
        </div>
      )}

      {activeBucket && activeBucket.enabled && (
        <BucketDrawer bucket={activeBucket} onClose={() => setActiveDrawer(null)} />
      )}

      <ToggleConfirmModal
        enabled={confirm?.enabled ?? false}
        pending={confirm != null && togglingBucket === confirm.name}
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
