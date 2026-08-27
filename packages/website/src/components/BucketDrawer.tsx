import { useEffect, useState } from 'react';
import { ProhibitIcon, XIcon } from '@phosphor-icons/react/dist/ssr';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { formatBytes, type QueryBucketResponse } from '@filone/shared';

import { queryBucket, type RagBucket } from '../lib/rag-bucket-api.js';
import { buildQueryCurl } from '../lib/rag-query-snippet.js';
import { timeAgo } from '../lib/time.js';
import { Button } from './Button.js';
import { CodeBlock } from './CodeBlock.js';
import { Input } from './Input.js';
import { QueryAnswer } from './QueryAnswer.js';
import { RequirePermission } from './RequirePermission.js';
import { BucketStatus } from './BucketStatus.js';

export type BucketDrawerProps = {
  bucket: RagBucket;
  onClose: () => void;
  /**
   * Opens the stop-indexing confirmation. Owned by the buckets tab so the drawer
   * and the row action share one confirm dialog and one mutation.
   */
  onStopIndexing: () => void;
};

/** Slide-over query playground for a single RAG-enabled bucket. */
export function BucketDrawer({ bucket, onClose, onStopIndexing }: BucketDrawerProps) {
  const [input, setInput] = useState('');
  const [question, setQuestion] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);

  const queryMutation = useMutation({
    mutationFn: (q: string) => queryBucket(bucket.name, bucket.region, q),
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

  return (
    <div data-testid="bucket-drawer">
      <div
        data-testid="bucket-drawer-overlay"
        aria-hidden="true"
        onClick={handleClose}
        className={`fixed inset-0 z-30 bg-black/40 transition-opacity duration-200 ${shown ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      />
      <div
        data-testid="bucket-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`RAG query playground for ${bucket.name}`}
        className={`fixed inset-y-0 right-0 z-40 flex w-[460px] flex-col border-l border-zinc-200 bg-white shadow-2xl transition-transform duration-200 ease-out ${shown ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <DrawerHeader bucket={bucket} onClose={handleClose} />
        <StatsBar bucket={bucket} />

        {/* Scrollable body */}
        <div data-testid="bucket-drawer-body" className="flex-1 overflow-y-auto">
          <AskSection
            bucket={bucket}
            input={input}
            question={question}
            onInputChange={setInput}
            onAsk={handleAsk}
            queryMutation={queryMutation}
          />
          <QueryFromCodeSection bucket={bucket} />
        </div>

        {/* Stopping discards the index, which the server reads as
            `buckets.delete` — the same permission behind the row's overflow
            menu, so the drawer cannot offer what the row already hides. The
            whole strip goes with it: it holds nothing else, and an empty
            bordered bar reads as a control that failed to load. */}
        <RequirePermission permission="buckets.delete">
          <DrawerFooter onStopIndexing={onStopIndexing} />
        </RequirePermission>
      </div>
    </div>
  );
}

/**
 * Stop-indexing lives in the drawer as well as the row's overflow menu: this is
 * the bucket's detail view, and without it, deciding to stop while watching a
 * long-running index means closing the drawer and hunting for the row's kebab.
 * Pinned to the bottom and visually separated so it is nowhere near "Ask".
 */
function DrawerFooter({ onStopIndexing }: { onStopIndexing: () => void }) {
  return (
    <div
      data-testid="bucket-drawer-footer"
      className="flex flex-shrink-0 justify-end border-t border-zinc-100 px-5 py-3"
    >
      <Button
        data-testid="bucket-drawer-stop"
        variant="ghost"
        size="sm"
        icon={ProhibitIcon}
        onClick={onStopIndexing}
      >
        Stop indexing
      </Button>
    </div>
  );
}

type DrawerHeaderProps = {
  bucket: RagBucket;
  onClose: () => void;
};

/** Top bar showing the bucket name and a close button. */
function DrawerHeader({ bucket, onClose }: DrawerHeaderProps) {
  return (
    <div
      data-testid="bucket-drawer-header"
      className="flex flex-shrink-0 items-center justify-between border-b border-zinc-100 px-5 py-4"
    >
      <div className="flex items-center gap-3 text-xs">
        <span data-testid="bucket-drawer-title" className="text-sm font-semibold text-zinc-900">
          {bucket.name}
        </span>
        {/* Same component as the bucket row, so the drawer cannot claim a
            different status from the row it was opened from. */}
        <BucketStatus bucket={bucket} />
      </div>
      <button
        data-testid="bucket-drawer-close"
        onClick={onClose}
        aria-label="Close"
        className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
      >
        <XIcon size={16} weight="bold" />
      </button>
    </div>
  );
}

type StatsBarProps = {
  bucket: RagBucket;
};

/**
 * Summary strip of index stats.
 *
 * Before the first pass completes the counters are both 0, so rendering
 * "0 files · 0 B · Not yet synced" says "nothing yet" three times and buries the
 * only useful fact. That state shows the wait instead, matching the bucket row.
 */
function StatsBar({ bucket }: StatsBarProps) {
  const wrapper =
    'flex flex-shrink-0 items-center gap-4 border-b border-zinc-100 bg-zinc-50/60 px-5 py-2.5 text-xs text-zinc-500';

  if (!bucket.lastSyncedAt) {
    return (
      <div data-testid="bucket-drawer-stats" className={wrapper}>
        <span data-testid="bucket-drawer-stat-waiting">Up to 6 hours until the first results</span>
      </div>
    );
  }

  return (
    <div data-testid="bucket-drawer-stats" className={wrapper}>
      <span data-testid="bucket-drawer-stat-files">
        <span className="font-medium text-zinc-800">{bucket.filesIndexed.toLocaleString()}</span>{' '}
        files
      </span>
      <span className="text-zinc-300">·</span>
      <span data-testid="bucket-drawer-stat-size" className="font-medium text-zinc-800">
        {formatBytes(bucket.indexSize)}
      </span>
      <span className="text-zinc-300">·</span>
      <span data-testid="bucket-drawer-stat-synced">
        {'Last indexed '}
        <span className="font-medium text-zinc-800">{timeAgo(bucket.lastSyncedAt)}</span>
      </span>
    </div>
  );
}

type AskSectionProps = {
  bucket: RagBucket;
  input: string;
  question: string | null;
  onInputChange: (value: string) => void;
  onAsk: () => void;
  queryMutation: UseMutationResult<QueryBucketResponse, Error, string>;
};

/**
 * Question input plus the streamed answer for the current query.
 *
 * Before the first indexing pass lands there is nothing to answer from (the API
 * rejects such queries with BUCKET_NOT_INDEXED), so the input is disabled and the
 * reason stated inline. The drawer still opens in that state, because the code
 * snippet below is exactly what a developer wants during the up-to-6-hour wait.
 */
function AskSection({
  bucket,
  input,
  question,
  onInputChange,
  onAsk,
  queryMutation,
}: AskSectionProps) {
  const { isPending, isError, error, data: result } = queryMutation;
  const notYetIndexed = !bucket.lastSyncedAt;

  return (
    <div data-testid="bucket-drawer-ask" className="px-5 py-5">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
        Ask a question
      </p>
      <div className="flex gap-2">
        <Input
          aria-label="Ask a question"
          placeholder={
            notYetIndexed ? 'Waiting for the first indexing pass…' : `Ask about ${bucket.name}…`
          }
          value={input}
          onChange={onInputChange}
          disabled={notYetIndexed}
          className="flex-1"
        />
        <Button
          data-testid="bucket-drawer-ask-submit"
          variant="primary"
          size="sm"
          disabled={notYetIndexed || !input.trim()}
          onClick={onAsk}
        >
          Ask
        </Button>
      </div>
      {notYetIndexed && (
        <p data-testid="bucket-drawer-not-indexed" className="mt-2 text-xs text-zinc-500">
          You can ask questions once the first indexing pass has completed, which can take up to 6
          hours.
        </p>
      )}
      <QueryAnswer
        bucket={bucket}
        question={question}
        isPending={isPending}
        isError={isError}
        error={error}
        result={result}
      />
    </div>
  );
}

/**
 * The same query as a copy-pasteable API call, scoped to this bucket. It lives
 * here rather than in a page-level tab because the bucket is already chosen, so
 * the snippet is runnable as-is with no bucket picker.
 */
function QueryFromCodeSection({ bucket }: { bucket: RagBucket }) {
  return (
    <div data-testid="bucket-drawer-code" className="border-t border-zinc-100 px-5 py-5">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
        Query from code
      </p>
      <CodeBlock
        code={buildQueryCurl({ bucketName: bucket.name, region: bucket.region })}
        language="bash"
      />
      <p className="mt-2 text-xs text-zinc-500">
        Create a key in the API Keys tab and export it as{' '}
        <code className="font-mono">FILONE_RAG_KEY</code>.
      </p>
    </div>
  );
}
