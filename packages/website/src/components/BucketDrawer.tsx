import { useEffect, useState } from 'react';
import { XIcon } from '@phosphor-icons/react/dist/ssr';
import { useMutation } from '@tanstack/react-query';

import { formatBytes } from '@filone/shared';

import { queryBucket, type RagBucket } from '../lib/rag-bucket-api.js';
import { timeAgo } from '../lib/time.js';
import { Button } from './Button.js';
import { Input } from './Input.js';
import { QueryAnswer } from './QueryAnswer.js';

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
