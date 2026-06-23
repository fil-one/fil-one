import { useEffect, useRef, useState } from 'react';
import { DotsThreeIcon, ProhibitIcon, XIcon } from '@phosphor-icons/react/dist/ssr';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import {
  S3Region,
  formatBytes,
  type BucketRagSyncState,
  type QueryBucketResponse,
} from '@filone/shared';

import { Alert } from '../components/Alert.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { Heading } from '../components/Heading/Heading.js';
import { Input } from '../components/Input.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../components/Modal/index.js';
import { Spinner } from '../components/Spinner.js';
import { queryBucket } from '../lib/rag-bucket-api.js';
import { timeAgo } from '../lib/time.js';

/** A bucket joined with its (possibly still-loading) RAG enablement state. */
export type RagBucket = {
  name: string;
  region: S3Region;
  /** Enablement source of truth (`status === 'active'`); decoupled from sync. */
  enabled: boolean;
  filesIndexed: number;
  indexSize: number;
  lastSyncedAt?: string;
  /**
   * Sync progress from the indexer (FIL-556); drives the Syncing…/Sync-failed
   * indicator only. Independent of `enabled`: a syncing/errored bucket is still
   * enabled and queryable.
   */
  syncState?: BucketRagSyncState;
  /** Failure reason, present only when `syncState === 'error'`. */
  lastSyncError?: string;
};

/**
 * Compact sync-status badge driven by the indexer telemetry (FIL-556). Renders
 * "Syncing…" while a reconciliation is in flight and "Sync failed" with the
 * reason (in the tooltip + visible text) on error. Returns null for the steady
 * `idle`/absent state, which the surrounding row already describes via the
 * files/size/last-synced line. Independent of enablement.
 */
function SyncStatusBadge({ bucket }: { bucket: RagBucket }) {
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

// ---------------------------------------------------------------------------
// ToggleConfirmModal
// ---------------------------------------------------------------------------

function ToggleConfirmModal({
  enabled,
  pending,
  open,
  onClose,
  onConfirm,
}: {
  enabled: boolean;
  pending: boolean;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} size="sm">
      <ModalHeader onClose={onClose}>
        {enabled ? 'Disable RAG Pipeline?' : 'Enable RAG Pipeline?'}
      </ModalHeader>
      <ModalBody>
        {enabled ? (
          <p className="text-sm text-zinc-600">
            Indexing will stop and this bucket will no longer be queryable via the API. Your
            documents and existing index data are not deleted.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
              <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                Pricing
              </p>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-6">
                  <span className="text-sm text-zinc-600">Per TB stored (with indexing)</span>
                  <span className="flex-shrink-0 text-sm font-semibold text-zinc-900">
                    $15 / TB / month
                  </span>
                </div>
                <div className="flex items-center justify-between gap-6">
                  <span className="text-sm text-zinc-600">LLM / embedding costs</span>
                  <span className="flex-shrink-0 text-sm font-semibold text-zinc-900">
                    Included
                  </span>
                </div>
              </div>
            </div>
            <p className="text-xs text-zinc-500">Disable at any time.</p>
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="md" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button
          variant={enabled ? 'destructive' : 'primary'}
          size="md"
          onClick={onConfirm}
          disabled={pending}
        >
          {enabled ? 'Disable' : 'Enable'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// BucketActionMenu
// ---------------------------------------------------------------------------

function BucketActionMenu({ onDisable }: { onDisable: () => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function handleOpen() {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen((o) => !o);
  }

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Bucket actions"
        onClick={handleOpen}
        className="rounded p-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
      >
        <DotsThreeIcon weight="bold" width={18} height={18} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          style={{ top: pos.top, right: pos.right }}
          className="fixed z-50 w-40 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onDisable();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            <ProhibitIcon size={14} />
            Disable
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BucketDrawer — Query Playground
// ---------------------------------------------------------------------------

function QuerySources({ bucket, sources }: { bucket: RagBucket; sources: string[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5 border-t border-zinc-100 pt-3">
      {sources.map((source) => (
        <Link
          key={source}
          to="/buckets/$bucketName/objects"
          params={{ bucketName: bucket.name }}
          search={{ key: source, region: bucket.region }}
          title={source}
          className="inline-flex items-center rounded-full border border-zinc-200 bg-white px-2.5 py-0.5 text-[11px] text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900"
        >
          {source.split('/').pop() ?? source}
        </Link>
      ))}
    </div>
  );
}

function QueryAnswer({
  bucket,
  question,
  isPending,
  isError,
  error,
  result,
}: {
  bucket: RagBucket;
  question: string | null;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  result: QueryBucketResponse | undefined;
}) {
  if (!((isPending && question) || isError || result)) return null;
  return (
    <div className="mt-4 rounded-lg border border-zinc-100 bg-zinc-50/50 p-4">
      {question && <p className="mb-3 text-xs italic text-zinc-400">"{question}"</p>}
      {isPending ? (
        <div className="space-y-2.5" aria-label="Loading answer">
          <div className="h-2 w-3/4 animate-pulse rounded-full bg-zinc-200" />
          <div className="h-2 w-full animate-pulse rounded-full bg-zinc-200" />
          <div className="h-2 w-5/6 animate-pulse rounded-full bg-zinc-200" />
          <div className="h-2 w-2/3 animate-pulse rounded-full bg-zinc-200" />
        </div>
      ) : isError ? (
        <Alert
          variant="red"
          description={error instanceof Error ? error.message : 'Something went wrong. Try again.'}
        />
      ) : result ? (
        <>
          <p className="text-sm leading-relaxed text-zinc-700">{result.answer}</p>
          <QuerySources bucket={bucket} sources={result.sources} />
        </>
      ) : null}
    </div>
  );
}

function BucketDrawer({ bucket, onClose }: { bucket: RagBucket; onClose: () => void }) {
  const [input, setInput] = useState('');
  const [question, setQuestion] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);

  const queryMutation = useMutation({
    mutationFn: (q: string) => queryBucket(bucket.name, q),
  });

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  function handleClose() {
    setClosing(true);
    setTimeout(onClose, 200);
  }

  function handleAsk() {
    const trimmed = input.trim();
    if (!trimmed) return;
    setQuestion(trimmed);
    setInput('');
    queryMutation.mutate(trimmed);
  }

  const shown = visible && !closing;
  const { isPending, isError, error, data: result } = queryMutation;

  return (
    <>
      <div
        className={`fixed inset-0 z-30 transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`}
        onClick={handleClose}
      />
      <div
        className={`fixed inset-y-0 right-0 z-40 flex w-[460px] flex-col border-l border-zinc-200 bg-white shadow-2xl transition-transform duration-200 ease-out ${shown ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-zinc-100 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            <span className="text-sm font-semibold text-zinc-900">{bucket.name}</span>
          </div>
          <button
            onClick={handleClose}
            aria-label="Close"
            className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
          >
            <XIcon size={16} weight="bold" />
          </button>
        </div>

        {/* Stats bar */}
        <div className="flex flex-shrink-0 items-center gap-4 border-b border-zinc-100 bg-zinc-50/60 px-5 py-2.5 text-xs text-zinc-500">
          <span>
            <span className="font-medium text-zinc-800">
              {bucket.filesIndexed.toLocaleString()}
            </span>{' '}
            files
          </span>
          <span className="text-zinc-300">·</span>
          <span className="font-medium text-zinc-800">{formatBytes(bucket.indexSize)}</span>
          <span className="text-zinc-300">·</span>
          <span>
            {bucket.lastSyncedAt ? (
              <>
                Last synced{' '}
                <span className="font-medium text-zinc-800">{timeAgo(bucket.lastSyncedAt)}</span>
              </>
            ) : (
              'Not yet synced'
            )}
          </span>
          {bucket.syncState === 'syncing' || bucket.syncState === 'error' ? (
            <>
              <span className="text-zinc-300">·</span>
              <SyncStatusBadge bucket={bucket} />
            </>
          ) : null}
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          {/* Ask section */}
          <div className="px-5 py-5">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
              Ask a question
            </p>
            <div className="flex gap-2">
              <Input
                placeholder={`Ask about ${bucket.name}…`}
                value={input}
                onChange={setInput}
                className="flex-1"
              />
              <Button variant="primary" size="sm" disabled={!input.trim()} onClick={handleAsk}>
                Ask
              </Button>
            </div>
            <QueryAnswer
              bucket={bucket}
              question={question}
              isPending={isPending}
              isError={isError}
              error={error}
              result={result}
            />
          </div>
        </div>
      </div>
    </>
  );
}

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
