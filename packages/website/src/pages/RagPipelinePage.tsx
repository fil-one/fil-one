import { useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  S3Region,
  formatBytes,
  usesRagEngine,
  type Bucket,
  type BucketRagEnablementResponse,
} from '@filone/shared';

import { Alert } from '../components/Alert.js';
import { Heading } from '../components/Heading/Heading.js';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '../components/Tabs/index.js';
import { useToast } from '../components/Toast/index.js';
import {
  bucketKey,
  getBucketRagEnabled,
  listBucketsForRag,
  setBucketRagEnabled,
} from '../lib/rag-bucket-api.js';
import { listRagApiKeys } from '../lib/rag-api-keys-api.js';
import { queryKeys } from '../lib/query-client.js';
import { useKeyActionScope } from '../lib/use-key-scope.js';
import { useRagAccess } from '../lib/use-rag-access.js';
import { BucketsTab, type RagBucket } from './RagPipelineBucketsTab.js';
import { RagApiKeysTab } from './RagPipelineKeysTab.js';

// ---------------------------------------------------------------------------
// RagPipelineView
// ---------------------------------------------------------------------------

/**
 * Placeholder while a counter's data is still in flight. A span rather than the
 * shared `Skeleton` (a div) because it sits inside the counter's paragraph, and
 * its height matches the line it stands in for so nothing moves when the value
 * lands: `value` for the 24px figure, `sub` for the 16px line under it.
 */
function StatSkeleton({ size = 'value' }: { size?: 'value' | 'sub' }) {
  return (
    <span
      data-testid="rag-pipeline-stat-loading"
      aria-hidden="true"
      className={`block max-w-full animate-pulse rounded-md bg-zinc-200 ${size === 'value' ? 'h-6 w-14' : 'h-4 w-24'}`}
    />
  );
}

interface Stat {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}

/** The page heading and spacing every state of the page shares, its error included. */
export function RagPipelineFrame({
  testId,
  children,
}: {
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId} className="px-10 py-12 pb-20">
      <div className="space-y-8">
        <Heading tag="h1" description="Turn any bucket into a queryable knowledge base.">
          Bucket Intelligence
        </Heading>
        {children}
      </div>
    </div>
  );
}

/**
 * One panel split by hairlines rather than separate cards: the numbers do not
 * need borders of their own competing with the tabs below, and a single
 * container keeps the values on a shared baseline. Labels are sentence case
 * (uppercase tracking-widest reads as legacy dashboard), and figures use
 * tabular-nums so digits line up as they change.
 */
function StatsPanel({ stats }: { stats: Stat[] }) {
  return (
    <div
      data-testid="rag-pipeline-stats"
      className={`grid ${stats.length === 3 ? 'grid-cols-3' : 'grid-cols-2'} divide-x divide-zinc-200 rounded-xl border border-zinc-200 bg-white`}
    >
      {stats.map((s) => (
        <div key={s.label} data-testid="rag-pipeline-stat" className="px-5 py-4">
          <p className="text-xs font-medium text-zinc-500">{s.label}</p>
          <p className="mt-1.5 text-2xl font-medium tabular-nums text-zinc-950">{s.value}</p>
          {s.sub && <p className="mt-1 text-xs text-zinc-500">{s.sub}</p>}
        </div>
      ))}
    </div>
  );
}

/**
 * A counter's rendered value, keeping the three cases distinct.
 *
 * A dash was previously shown for both "still loading" and "the request failed",
 * so a failed request left something that looked like a real value sitting there
 * forever with no error surfaced. Loading now shows a skeleton and failure says
 * so in words.
 */
function statValue({
  pending,
  failed,
  value,
}: {
  pending: boolean;
  failed: boolean;
  value: string;
}): React.ReactNode {
  if (failed) return <span className="text-base font-medium text-zinc-500">Unavailable</span>;
  if (pending) return <StatSkeleton />;
  return value;
}

function RagPipelineView({
  buckets,
  showApiKeyCount,
  apiKeyCount,
  apiKeysPending,
  apiKeysError,
  isLoading,
  isError,
  errorMessage,
  togglingBucket,
  onConfirmToggle,
}: {
  buckets: RagBucket[];
  /** Whether the caller may list keys at all — the counter is theirs or absent. */
  showApiKeyCount: boolean;
  /** Org's RAG API key count; undefined until the request resolves. */
  apiKeyCount: number | undefined;
  apiKeysPending: boolean;
  apiKeysError: boolean;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | undefined;
  togglingBucket: string | null;
  onConfirmToggle: (bucket: RagBucket) => void;
}) {
  const totalFiles = buckets.reduce((sum, b) => sum + (b.enabled ? b.filesIndexed : 0), 0);
  const totalIndexSize = buckets.reduce((sum, b) => sum + (b.enabled ? b.indexSize : 0), 0);
  const indexedBuckets = buckets.filter((b) => b.enabled).length;

  // Once loaded the counters read 0 before any bucket is indexed, which is the
  // truth, so there is no separate "not enabled" placeholder state. The
  // per-bucket rows below carry the enablement state. While the bucket data is
  // still arriving, though, 0 would be a claim rather than a fact, so the
  // counters show a skeleton instead.
  const stats: Stat[] = [
    {
      label: 'Files indexed',
      value: statValue({
        pending: isLoading,
        failed: isError,
        value: totalFiles.toLocaleString(),
      }),
      // The card label already says "indexed", so repeating it here is noise.
      // While the buckets load, a count here would be a claim, like the figure.
      sub: isLoading ? (
        <StatSkeleton size="sub" />
      ) : indexedBuckets === 1 ? (
        'across 1 bucket'
      ) : (
        `across ${indexedBuckets} buckets`
      ),
    },
    {
      label: 'Index size',
      value: statValue({
        pending: isLoading,
        failed: isError,
        value: formatBytes(totalIndexSize),
      }),
      sub: 'total size of indexed files',
    },
    // Absent rather than "Unavailable" for a role that cannot list keys: the
    // count is not a fact being withheld, it is not their counter.
    ...(showApiKeyCount
      ? [
          {
            label: 'API keys',
            value: statValue({
              pending: apiKeysPending,
              failed: apiKeysError,
              value: (apiKeyCount ?? 0).toLocaleString(),
            }),
            sub: 'for the Query API',
          },
        ]
      : []),
  ];

  return (
    <RagPipelineFrame testId="rag-pipeline-page">
      <StatsPanel stats={stats} />

      <Tabs>
        <TabList>
          <Tab>Buckets</Tab>
          <Tab>API Keys</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <BucketsTab
              buckets={buckets}
              isLoading={isLoading}
              isError={isError}
              errorMessage={errorMessage}
              togglingBucket={togglingBucket}
              onConfirmToggle={onConfirmToggle}
            />
          </TabPanel>
          <TabPanel>
            <RagApiKeysTab buckets={buckets} />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </RagPipelineFrame>
  );
}

/**
 * The page as it stands before `/me` has said whether the caller may use the
 * feature: the heading, the counters as placeholders and the Buckets tab in its
 * loading state. It mounts nothing that makes a request, so a caller who turns
 * out to be off the allowlist sends none. The API Keys tab is disabled rather
 * than left to open, because its panel decides what to show from permissions
 * that come from the same pending `/me`.
 */
export function RagPipelineSkeleton() {
  return (
    <RagPipelineFrame testId="rag-pipeline-loading">
      <StatsPanel
        stats={[
          { label: 'Files indexed', value: <StatSkeleton />, sub: <StatSkeleton size="sub" /> },
          { label: 'Index size', value: <StatSkeleton />, sub: 'total size of indexed files' },
          { label: 'API keys', value: <StatSkeleton />, sub: 'for the Query API' },
        ]}
      />
      <Tabs>
        <TabList>
          <Tab>Buckets</Tab>
          <Tab disabled>API Keys</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <BucketsTab
              buckets={[]}
              isLoading
              isError={false}
              errorMessage={undefined}
              togglingBucket={null}
              onConfirmToggle={() => {}}
            />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </RagPipelineFrame>
  );
}

// ---------------------------------------------------------------------------
// NotAvailable — defense-in-depth render when access is denied
// ---------------------------------------------------------------------------

function NotAvailable() {
  return (
    <div data-testid="rag-pipeline-not-available" className="px-10 py-12">
      <Alert variant="grey" description="Bucket Intelligence is not available for your account." />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page export
// ---------------------------------------------------------------------------

/**
 * How often to re-read one bucket's enablement, per bucket.
 *
 * The indexer writes `syncState`/`lastSyncedAt` out of band, so without polling a
 * bucket showed "Indexing" until the page was manually reloaded: the copy tells
 * people to come back in a few hours, and on return the page still claimed to be
 * working. Polling stops as soon as there is nothing left to wait for, so a
 * settled page makes no repeat requests.
 *
 * The first pass can take up to 6 hours, so that state polls far more slowly than
 * an in-flight run; `refetchOnWindowFocus` (on by default) covers the common case
 * of someone returning to the tab.
 *
 * `error` is not a settled state: the orchestrator keeps re-indexing enabled
 * buckets whose last run failed, so a later pass can succeed on its own. Stopping
 * on error would leave the row reading "Failed" until a manual reload, so it keeps
 * polling at the slow interval even once `lastSyncedAt` exists.
 */
export function enablementPollInterval(
  query: {
    state: { data?: BucketRagEnablementResponse };
  },
  region?: S3Region,
): number | false {
  const data = query.state.data;
  if (!data?.enabled) return false;
  // Engine-backed (Forge) runs start on demand and finish in minutes, so the
  // row follows them closely; scheduled runs take far longer.
  if (data.syncState === 'syncing') return region && usesRagEngine(region) ? 3_000 : 30_000;
  if (data.syncState === 'error') return 120_000;
  if (!data.lastSyncedAt) return 120_000;
  return false;
}

export function RagPipelinePage() {
  const ragAccess = useRagAccess();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [togglingBucket, setTogglingBucket] = useState<string | null>(null);

  const {
    data: bucketsData,
    isPending: bucketsPending,
    isError: bucketsError,
    error: bucketsErr,
  } = useQuery({
    queryKey: queryKeys.ragBuckets,
    queryFn: () => listBucketsForRag(),
    enabled: ragAccess,
  });

  const bucketList: Bucket[] = bucketsData?.buckets ?? [];

  // Same query key as the API Keys tab, so the count and the table stay in
  // sync (creates/deletes invalidate ['rag-api-keys']) and the two surfaces
  // share one request. Both are gated the same way: without `keys.manage_own`
  // the list is refused, and a counter is not worth a 403.
  const { mayList: mayListKeys } = useKeyActionScope();
  const {
    data: apiKeysData,
    isPending: apiKeysPending,
    isError: apiKeysError,
  } = useQuery({
    queryKey: queryKeys.ragApiKeys,
    queryFn: () => listRagApiKeys(),
    enabled: ragAccess && mayListKeys,
  });

  const enablementQueries = useQueries({
    queries: bucketList.map((b) => ({
      queryKey: queryKeys.ragBucketEnabledFor(b.bucketName, b.region as S3Region),
      queryFn: () => getBucketRagEnabled(b.bucketName, b.region as S3Region),
      enabled: ragAccess,
      refetchInterval: (query: { state: { data?: BucketRagEnablementResponse } }) =>
        enablementPollInterval(query, b.region as S3Region),
    })),
  });

  const toggleMutation = useMutation({
    mutationFn: ({
      bucketName,
      region,
      enabled,
    }: {
      bucketName: string;
      region: S3Region;
      enabled: boolean;
    }) => setBucketRagEnabled(bucketName, region, enabled),
    onSuccess: (data, { bucketName, region }) => {
      queryClient.setQueryData(queryKeys.ragBucketEnabledFor(bucketName, region), data);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.ragBucketEnabledFor(bucketName, region),
      });
      toast.success(
        data.enabled
          ? `Indexing started for "${bucketName}"`
          : `Indexing stopped for "${bucketName}"`,
      );
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update indexing for this bucket');
    },
    onSettled: () => setTogglingBucket(null),
  });

  if (!ragAccess) return <NotAvailable />;

  const buckets: RagBucket[] = bucketList.map((b, i) => {
    const enablement = enablementQueries[i]?.data;
    return {
      name: b.bucketName,
      region: b.region as S3Region,
      enabled: enablement?.enabled ?? false,
      filesIndexed: enablement?.filesIndexed ?? 0,
      indexSize: enablement?.indexSize ?? 0,
      ...(enablement?.lastSyncedAt ? { lastSyncedAt: enablement.lastSyncedAt } : {}),
      ...(enablement?.syncState ? { syncState: enablement.syncState } : {}),
      ...(enablement?.lastSyncError ? { lastSyncError: enablement.lastSyncError } : {}),
    };
  });

  function handleConfirmToggle(bucket: RagBucket) {
    setTogglingBucket(bucketKey(bucket));
    toggleMutation.mutate({
      bucketName: bucket.name,
      region: bucket.region,
      enabled: !bucket.enabled,
    });
  }

  const enablementLoading = enablementQueries.some((q) => q.isPending);

  return (
    <RagPipelineView
      buckets={buckets}
      showApiKeyCount={mayListKeys}
      apiKeyCount={apiKeysData?.keys.length}
      apiKeysPending={apiKeysPending}
      apiKeysError={apiKeysError}
      isLoading={bucketsPending || (bucketList.length > 0 && enablementLoading)}
      isError={bucketsError}
      errorMessage={bucketsErr instanceof Error ? bucketsErr.message : undefined}
      togglingBucket={togglingBucket}
      onConfirmToggle={handleConfirmToggle}
    />
  );
}
