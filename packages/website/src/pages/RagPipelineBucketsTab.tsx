import { useState } from 'react';

import { formatBytes } from '@filone/shared';

import { Alert } from '../components/Alert.js';
import { BucketActionMenu } from '../components/BucketActionMenu.js';
import { RequirePermission } from '../components/RequirePermission.js';
import { BucketDrawer } from '../components/BucketDrawer.js';
import { BucketStatus } from '../components/BucketStatus.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { Heading } from '../components/Heading/Heading.js';
import { Spinner } from '../components/Spinner.js';
import { ToggleConfirmModal } from '../components/ToggleConfirmModal.js';
import {
  bucketDisplayState,
  bucketKey,
  isBucketQueryable,
  type RagBucket,
} from '../lib/rag-bucket-api.js';
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
 * The detail that follows the status on the metadata line, or nothing when the
 * status already says everything.
 *
 * Before the first pass completes it deliberately does NOT show the file count and
 * index size: both are 0, and "0 files indexed · 0 B" alongside an Indexing status
 * says "nothing yet" three times while burying the only fact that matters, which
 * is how long the wait is. The stats appear once they mean something.
 */
function BucketRowDetail({ bucket }: { bucket: RagBucket }) {
  const detail = detailFor(bucket);
  if (!detail) return null;
  return (
    <>
      <span aria-hidden="true">·</span>
      <span className="truncate">{detail}</span>
    </>
  );
}

function detailFor(bucket: RagBucket): React.ReactNode {
  switch (bucketDisplayState(bucket)) {
    // The status alone is the whole story for a bucket nobody has indexed.
    case 'not-indexed':
      return null;
    case 'syncing':
      return 'Checking for new and changed files';
    case 'error':
      return bucket.lastSyncError ?? 'The last indexing run did not complete';
    case 'awaiting-first-index':
      return 'Up to 6 hours until the first results';
    case 'synced':
      return <BucketSyncedStats bucket={bucket} />;
  }
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
        {/* Title line is the name alone; everything else is one muted,
            dot-separated metadata line led by the status. Nothing on the first
            line can inflate it, so the two lines keep a fixed rhythm. */}
        <div className="min-w-0">
          <p
            data-testid="bucket-row-name"
            className="truncate text-sm font-medium leading-5 text-zinc-800"
          >
            {bucket.name}
          </p>
          <p
            data-testid="bucket-row-status"
            data-sync-state={bucketDisplayState(bucket)}
            className="mt-0.5 flex items-center gap-1.5 text-xs leading-4 text-zinc-500"
          >
            <BucketStatus bucket={bucket} />
            <BucketRowDetail bucket={bucket} />
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-3">
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {bucket.enabled ? (
              <>
                {/* Opens for any enabled bucket, including before the first pass has
                  landed: the drawer also holds the API snippet, which is what a
                  developer needs during the up-to-6-hour wait. The label tracks
                  what the drawer can actually do, so it never offers asking while
                  the question input inside is still disabled. */}
                <Button data-testid="bucket-row-ask" variant="ghost" size="sm" onClick={onAsk}>
                  {isBucketQueryable(bucket) ? 'Ask questions' : 'View details'}
                </Button>
                {/* Turning indexing off discards the index, so it sits with
                    bucket deletion; turning it on is a configuration write and
                    sits with bucket creation. Asking questions needs neither. */}
                <RequirePermission permission="buckets.delete">
                  <BucketActionMenu onDisable={onToggle} />
                </RequirePermission>
              </>
            ) : (
              <RequirePermission permission="buckets.create">
                <Button
                  data-testid="bucket-row-index"
                  variant="primary"
                  size="sm"
                  disabled={pending}
                  onClick={onToggle}
                >
                  {pending ? 'Starting…' : 'Index'}
                </Button>
              </RequirePermission>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// BucketsListState
// ---------------------------------------------------------------------------

/** Error / loading / empty / populated branch for the bucket list. */
function BucketsListState({
  buckets,
  isLoading,
  isError,
  errorMessage,
  togglingBucket,
  onToggle,
  onAsk,
}: {
  buckets: RagBucket[];
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | undefined;
  togglingBucket: string | null;
  onToggle: (bucket: RagBucket) => void;
  onAsk: (bucket: RagBucket) => void;
}) {
  if (isError) {
    return (
      <div data-testid="buckets-error">
        <Alert variant="red" description={errorMessage ?? 'Failed to load buckets'} />
      </div>
    );
  }
  if (isLoading) {
    return (
      <div data-testid="buckets-loading" className="flex items-center justify-center py-12">
        <Spinner ariaLabel="Loading buckets" size={28} />
      </div>
    );
  }
  if (buckets.length === 0) {
    return (
      <div data-testid="buckets-empty">
        <Alert variant="grey" description="You don't have any buckets yet." />
      </div>
    );
  }
  return (
    <div data-testid="buckets-list" className="space-y-3">
      {buckets.map((b) => (
        <BucketRow
          key={bucketKey(b)}
          bucket={b}
          pending={togglingBucket === bucketKey(b)}
          onToggle={() => onToggle(b)}
          onAsk={() => onAsk(b)}
        />
      ))}
    </div>
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
      <BucketsListState
        buckets={buckets}
        isLoading={isLoading}
        isError={isError}
        errorMessage={errorMessage}
        togglingBucket={togglingBucket}
        onToggle={setConfirm}
        onAsk={(bucket) => setActiveDrawer(bucketKey(bucket))}
      />

      {activeBucket && activeBucket.enabled && (
        <BucketDrawer
          bucket={activeBucket}
          onClose={() => setActiveDrawer(null)}
          // Same confirm dialog as the row's overflow action. Confirming disables
          // the bucket, which unmounts the drawer via the `enabled` guard above.
          onStopIndexing={() => setConfirm(activeBucket)}
        />
      )}

      <ToggleConfirmModal
        enabled={confirm?.enabled ?? false}
        bucketName={confirm?.name ?? ''}
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
