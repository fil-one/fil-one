import { useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { S3Region, formatBytes, type Bucket } from '@filone/shared';

import { Alert } from '../components/Alert.js';
import { Badge } from '../components/Badge.js';
import { Heading } from '../components/Heading/Heading.js';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '../components/Tabs/index.js';
import { useToast } from '../components/Toast/index.js';
import {
  getBucketRagEnabled,
  listBucketsForRag,
  setBucketRagEnabled,
} from '../lib/rag-bucket-api.js';
import { queryKeys } from '../lib/query-client.js';
import { useRagAccess } from '../lib/use-rag-access.js';
import { BucketsTab, type RagBucket } from './RagPipelineBucketsTab.js';
import { IntegrateTab, ModelsTab } from './RagPipelineTabs.js';

// ---------------------------------------------------------------------------
// RagPipelineView
// ---------------------------------------------------------------------------

function RagPipelineView({
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
  const anyEnabled = buckets.some((b) => b.enabled);
  const totalFiles = buckets.reduce((sum, b) => sum + (b.enabled ? b.filesIndexed : 0), 0);
  const totalIndexSize = buckets.reduce((sum, b) => sum + (b.enabled ? b.indexSize : 0), 0);

  const stats = [
    {
      label: 'Files indexed',
      value: anyEnabled ? totalFiles.toLocaleString() : '—',
      sub: anyEnabled ? 'across all buckets' : 'Available once enabled',
    },
    {
      label: 'Index size',
      value: anyEnabled ? formatBytes(totalIndexSize) : '—',
      sub: anyEnabled ? 'total storage used' : 'Available once enabled',
    },
    {
      label: 'Pricing',
      value: '$15 / TB',
      sub: 'per month · LLM costs included',
    },
  ];

  return (
    <div className="px-10 py-12 pb-20">
      <div className="space-y-8">
        <div className="flex items-start justify-between gap-6">
          <Heading
            tag="h1"
            size="2xl"
            description="Turn any bucket into a queryable knowledge base."
          >
            <span className="inline-flex items-center gap-2.5">
              RAG Pipeline
              {anyEnabled ? (
                <Badge color="green" size="sm" strength="strong" dot>
                  Active
                </Badge>
              ) : (
                <Badge color="grey" size="sm" strength="strong">
                  Not enabled
                </Badge>
              )}
            </span>
          </Heading>
        </div>

        <div className={`grid grid-cols-3 gap-3 ${!anyEnabled ? 'opacity-60' : ''}`}>
          {stats.map((s) => (
            <div key={s.label} className="rounded-xl border border-zinc-200 bg-white p-5">
              <p className="mb-2.5 text-xs font-medium uppercase tracking-wider text-zinc-500">
                {s.label}
              </p>
              <p className="text-xl font-semibold text-zinc-950">{s.value}</p>
              <p className="mt-1 text-xs text-zinc-400">{s.sub}</p>
            </div>
          ))}
        </div>

        <Tabs>
          <TabList>
            <Tab>Buckets</Tab>
            <Tab>Models</Tab>
            <Tab>Integrate</Tab>
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
              <ModelsTab enabled={anyEnabled} />
            </TabPanel>
            <TabPanel>
              <IntegrateTab enabled={anyEnabled} buckets={buckets} />
            </TabPanel>
          </TabPanels>
        </Tabs>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NotAvailable — defense-in-depth render when access is denied
// ---------------------------------------------------------------------------

function NotAvailable() {
  return (
    <div className="px-10 py-12">
      <Alert variant="grey" description="RAG Pipeline is not available for your account." />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page export
// ---------------------------------------------------------------------------

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

  const enablementQueries = useQueries({
    queries: bucketList.map((b) => ({
      queryKey: queryKeys.ragBucketEnabledFor(b.bucketName, b.region as S3Region),
      queryFn: () => getBucketRagEnabled(b.bucketName, b.region as S3Region),
      enabled: ragAccess,
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
      toast.success(`RAG ${data.enabled ? 'enabled' : 'disabled'} for "${bucketName}"`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update RAG enablement');
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
    setTogglingBucket(bucket.name);
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
      isLoading={bucketsPending || (bucketList.length > 0 && enablementLoading)}
      isError={bucketsError}
      errorMessage={bucketsErr instanceof Error ? bucketsErr.message : undefined}
      togglingBucket={togglingBucket}
      onConfirmToggle={handleConfirmToggle}
    />
  );
}
