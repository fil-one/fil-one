import { useEffect, useMemo, useRef, useState } from 'react';
import { ProhibitIcon, XIcon } from '@phosphor-icons/react/dist/ssr';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';

import {
  ApiErrorCode,
  formatBytes,
  usesRagEngine,
  type BucketRagEngineResponse,
  type QueryBucketResponse,
  type RagEngineVersion,
  type RagSearchMode,
} from '@filone/shared';

import {
  getBucketRagEngine,
  queryBucket,
  syncBucketRag,
  type QueryBucketOptions,
  type RagBucket,
} from '../lib/rag-bucket-api.js';
import { errorCodeOf } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';
import { ENGINE_SYNC_POLL_MS, getSearchableVersions, isEngineStatus } from '../lib/rag-engine.js';
import { useHasPermission } from '../lib/use-permissions.js';
import { buildQueryCurl } from '../lib/rag-query-snippet.js';
import { timeAgo } from '../lib/time.js';
import { Button } from './Button.js';
import { CodeBlock } from './CodeBlock.js';
import { Input } from './Input.js';
import { QueryAnswer } from './QueryAnswer.js';
import { RagDatasetPanel, RagEngineSyncStrip } from './RagEnginePanel.js';
import { RagSearchControls, useDatasetVersion } from './RagSearchControls.js';
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

type AskVariables = { query: string; searchMode?: RagSearchMode; version?: number };

/**
 * Slide-over query playground for a single RAG-enabled bucket.
 *
 * Engine-backed (Forge) buckets get more: Index now with live progress, a search
 * mode and dataset version picker, cited answers with a retrieval trace, and the
 * Lance dataset panel. Every other region renders as it always has.
 */
export function BucketDrawer({ bucket: rowBucket, onClose, onStopIndexing }: BucketDrawerProps) {
  const [input, setInput] = useState('');
  const [question, setQuestion] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [searchMode, setSearchMode] = useState<RagSearchMode>('hybrid');

  const engine = useRagEngine(rowBucket);
  const syncing = engine.data?.status.syncState === 'syncing';
  const allVersions = engine.data?.versions ?? EMPTY_VERSIONS;
  const versions = useMemo(
    () => getSearchableVersions(allVersions, syncing),
    [allVersions, syncing],
  );
  const [version, setVersion] = useDatasetVersion(versions);
  // The engine reads its own dataset, so while the drawer is open its numbers
  // are fresher than the row's enablement poll.
  const bucket = engine.isEngine ? withEngineStatus(rowBucket, engine.data) : rowBucket;

  const queryMutation = useMutation({
    mutationFn: ({ query, ...options }: AskVariables) =>
      engine.isEngine
        ? queryBucket(bucket.name, bucket.region, query, options satisfies QueryBucketOptions)
        : queryBucket(bucket.name, bucket.region, query),
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
    // Mid-run, the engine's own latest is a partial commit, so Latest is pinned
    // to the newest version the picker offers: the last finished sync.
    const askVersion = version ?? (syncing ? versions[0]?.version : undefined);
    queryMutation.mutate(
      engine.isEngine ? { query: trimmed, searchMode, version: askVersion } : { query: trimmed },
    );
  }

  const shown = visible && !closing;

  return (
    <div data-testid="bucket-drawer">
      <div
        data-testid="bucket-drawer-overlay"
        aria-hidden="true"
        onClick={handleClose}
        className={`fixed inset-0 z-30 bg-black/40 transition-opacity duration-200 ${shown ? 'opacity-100 ease-out' : 'pointer-events-none opacity-0 ease-in'}`}
      />
      <div
        data-testid="bucket-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`RAG query playground for ${bucket.name}`}
        className={`fixed inset-y-0 right-0 z-40 flex ${engine.isEngine ? 'w-[560px] max-w-full' : 'w-[460px]'} flex-col bg-white shadow-xl transition-transform duration-200 motion-reduce:duration-0 ${shown ? 'translate-x-0 ease-out' : 'translate-x-full ease-in'}`}
      >
        <DrawerHeader bucket={bucket} onClose={handleClose} />
        <StatsBar bucket={bucket} engine={engine.isEngine} />
        {engine.isEngine && (
          <RagEngineSyncStrip
            status={engine.data?.status}
            canSync={engine.canSync}
            onSync={engine.sync}
            syncRequested={engine.syncRequested}
            error={engine.error}
          />
        )}

        {/* Scrollable body */}
        <div data-testid="bucket-drawer-body" className="flex-1 overflow-y-auto">
          <AskSection
            bucket={bucket}
            input={input}
            question={question}
            onInputChange={setInput}
            onAsk={handleAsk}
            queryMutation={queryMutation}
            canSync={engine.canSync}
            controls={
              engine.isEngine ? (
                <RagSearchControls
                  mode={searchMode}
                  onModeChange={setSearchMode}
                  version={version}
                  onVersionChange={setVersion}
                  versions={versions}
                  disabled={!bucket.lastSyncedAt}
                />
              ) : null
            }
          />
          {engine.isEngine && engine.data?.status.dataset && (
            <RagDatasetPanel bucket={bucket} dataset={engine.data.status.dataset} />
          )}
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
        <span data-testid="bucket-drawer-title" className="text-sm font-medium text-zinc-900">
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
        className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
      >
        <XIcon size={16} weight="bold" />
      </button>
    </div>
  );
}

type StatsBarProps = {
  bucket: RagBucket;
  /** Engine-backed buckets index on demand, so there is no scheduled wait to quote. */
  engine?: boolean;
};

/**
 * Summary strip of index stats.
 *
 * Before the first pass completes the counters are both 0, so rendering
 * "0 files · 0 B · Not yet synced" says "nothing yet" three times and buries the
 * only useful fact. That state shows the wait instead, matching the bucket row.
 */
function StatsBar({ bucket, engine }: StatsBarProps) {
  const wrapper =
    'flex flex-shrink-0 items-center gap-4 border-b border-zinc-100 bg-zinc-50/60 px-5 py-2.5 text-xs text-zinc-500';

  if (!bucket.lastSyncedAt) {
    return (
      <div data-testid="bucket-drawer-stats" className={wrapper}>
        <span data-testid="bucket-drawer-stat-waiting">
          {engine ? 'Not indexed yet' : 'Up to 6 hours until the first results'}
        </span>
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
  queryMutation: UseMutationResult<QueryBucketResponse, Error, AskVariables>;
  /** Engine-backed buckets: search mode and dataset version, above the input. */
  controls?: React.ReactNode;
  /** Whether the viewer can start an engine run, so the copy only names Index now when they have it. */
  canSync?: boolean;
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
  controls,
  canSync,
}: AskSectionProps) {
  const { isPending, isError, error, data: result } = queryMutation;
  const notYetIndexed = !bucket.lastSyncedAt;
  const engine = usesRagEngine(bucket.region);

  return (
    <div data-testid="bucket-drawer-ask" className="px-5 py-5">
      <p className="mb-3 text-meta font-medium uppercase tracking-widest text-zinc-500">
        Ask a question
      </p>
      {controls}
      <div className="flex gap-2">
        <Input
          aria-label="Ask a question"
          placeholder={
            notYetIndexed ? 'Waiting for the first indexing pass…' : `Ask about ${bucket.name}…`
          }
          value={input}
          onChange={onInputChange}
          // Enter-to-ask is part of the engine-backed drawer only; other regions
          // keep their existing behaviour. An Enter that confirms an IME
          // candidate is not a submit. Chrome and Firefox flag it with
          // isComposing; Safari ends the composition first and reports the
          // IME key code 229 instead.
          onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
            if (
              engine &&
              event.key === 'Enter' &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229 &&
              !notYetIndexed &&
              input.trim()
            ) {
              onAsk();
            }
          }}
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
          {engine
            ? canSync
              ? 'You can ask questions once the first indexing run has finished. Start one with Index now.'
              : 'You can ask questions once the first indexing run has finished.'
            : 'You can ask questions once the first indexing pass has completed, which can take up to 6 hours.'}
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
      <p className="mb-3 text-meta font-medium uppercase tracking-widest text-zinc-500">
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

const EMPTY_VERSIONS: RagEngineVersion[] = [];

/** The drawer's bucket with the engine's own telemetry laid over the row's. */
function withEngineStatus(
  bucket: RagBucket,
  engine: BucketRagEngineResponse | undefined,
): RagBucket {
  if (!engine) return bucket;
  const { status } = engine;
  return {
    ...bucket,
    filesIndexed: status.filesIndexed,
    indexSize: status.indexedBytes,
    // The engine is the source of truth inside the drawer: a field it leaves out
    // is cleared rather than inherited from a stale row.
    lastSyncedAt: status.lastSyncedAt,
    syncState: status.syncState,
    lastSyncError: status.lastSyncError,
  };
}

/**
 * What the sync strip says when Index now or the engine read fails. The sync
 * error wins, since it answers the presenter's last click (a new click clears
 * it). An engine read refused with BUCKET_NOT_INDEXED means no dataset exists
 * yet, which the strip already shows as the empty state.
 */
function engineErrorMessage(
  syncError: Error | null,
  engineError: Error | null,
): string | undefined {
  if (syncError) return `Couldn't start indexing. ${syncError.message}`;
  if (engineError && errorCodeOf(engineError) !== ApiErrorCode.BUCKET_NOT_INDEXED) {
    return `Couldn't reach the indexing engine. ${engineError.message}`;
  }
  return undefined;
}

/**
 * Engine status, version history and Index now for a Forge bucket. Polls every
 * few seconds while a run is in flight (or was just requested), and stops once
 * it settles. When a run finishes, the bucket's enablement is re-read so the
 * row behind the drawer catches up.
 */
function useRagEngine(bucket: RagBucket) {
  const isEngine = usesRagEngine(bucket.region);
  const queryClient = useQueryClient();
  const canSync = useHasPermission('buckets.create');
  const key = queryKeys.ragBucketEngineFor(bucket.name, bucket.region);

  const syncMutation = useMutation({
    mutationFn: () => syncBucketRag(bucket.name, bucket.region),
    onSuccess: (status) => {
      // The engine answers with its status; lay it over the cached response so
      // progress shows without waiting for the next poll.
      if (isEngineStatus(status)) {
        queryClient.setQueryData<BucketRagEngineResponse>(key, (prev) => ({
          versions: prev?.versions ?? [],
          status: { ...prev?.status, ...status },
        }));
      }
      void queryClient.invalidateQueries({ queryKey: key });
      // The row behind the drawer only polls while it reads `syncing`, so tell
      // it a run has started rather than waiting for the run to end.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.ragBucketEnabledFor(bucket.name, bucket.region),
      });
    },
  });

  const { data, error: engineError } = useQuery({
    queryKey: key,
    queryFn: () => getBucketRagEngine(bucket.name, bucket.region),
    enabled: isEngine && bucket.enabled,
    refetchInterval: (query) =>
      query.state.data?.status.syncState === 'syncing' || syncMutation.isPending
        ? ENGINE_SYNC_POLL_MS
        : false,
  });

  const syncState = data?.status.syncState;
  const previous = useRef(syncState);
  useEffect(() => {
    if (previous.current === 'syncing' && syncState !== 'syncing') {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.ragBucketEnabledFor(bucket.name, bucket.region),
      });
    }
    previous.current = syncState;
  }, [syncState, queryClient, bucket.name, bucket.region]);

  return {
    isEngine,
    data,
    canSync,
    sync: () => syncMutation.mutate(),
    syncRequested: syncMutation.isPending,
    error: engineErrorMessage(syncMutation.error, engineError),
  };
}
