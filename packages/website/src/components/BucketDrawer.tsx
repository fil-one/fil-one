import { useEffect, useState } from 'react';
import { XIcon } from '@phosphor-icons/react/dist/ssr';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { formatBytes, type QueryBucketResponse } from '@filone/shared';

import { queryBucket, type RagBucket } from '../lib/rag-bucket-api.js';
import { timeAgo } from '../lib/time.js';
import { Button } from './Button.js';
import { Input } from './Input.js';
import { QueryAnswer } from './QueryAnswer.js';
import { SyncStatusBadge } from './SyncStatusBadge.js';

export type BucketDrawerProps = {
  bucket: RagBucket;
  onClose: () => void;
};

/** Slide-over query playground for a single RAG-enabled bucket. */
export function BucketDrawer({ bucket, onClose }: BucketDrawerProps) {
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
        </div>
      </div>
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
      <div className="flex items-center gap-2.5">
        <span className="h-2 w-2 rounded-full bg-green-500" />
        <span data-testid="bucket-drawer-title" className="text-sm font-semibold text-zinc-900">
          {bucket.name}
        </span>
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

/** Summary strip of index stats: file count, size, and last-synced time. */
function StatsBar({ bucket }: StatsBarProps) {
  return (
    <div
      data-testid="bucket-drawer-stats"
      className="flex flex-shrink-0 items-center gap-4 border-b border-zinc-100 bg-zinc-50/60 px-5 py-2.5 text-xs text-zinc-500"
    >
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

/** Question input plus the streamed answer for the current query. */
function AskSection({
  bucket,
  input,
  question,
  onInputChange,
  onAsk,
  queryMutation,
}: AskSectionProps) {
  const { isPending, isError, error, data: result } = queryMutation;

  return (
    <div data-testid="bucket-drawer-ask" className="px-5 py-5">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
        Ask a question
      </p>
      <div className="flex gap-2">
        <Input
          placeholder={`Ask about ${bucket.name}…`}
          value={input}
          onChange={onInputChange}
          className="flex-1"
        />
        <Button
          data-testid="bucket-drawer-ask-submit"
          variant="primary"
          size="sm"
          disabled={!input.trim()}
          onClick={onAsk}
        >
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
  );
}
