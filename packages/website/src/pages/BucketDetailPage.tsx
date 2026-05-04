import { useCallback, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpIcon, KeyIcon, CubeIcon, HardDrivesIcon } from '@phosphor-icons/react/dist/ssr';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { Heading } from '../components/Heading/Heading';
import { Button } from '../components/Button';
import { Tabs, TabList, Tab, TabPanels, TabPanel } from '../components/Tabs';
import { Breadcrumb } from '../components/Breadcrumb';
import { Spinner } from '../components/Spinner';
import { AddBucketKeyModal } from '../components/AddBucketKeyModal';
import { BucketPropertiesCard } from '../components/BucketPropertiesCard';
import { ObjectBrowser } from '../components/ObjectBrowser';
import { BucketAccessTab } from '../components/BucketAccessTab';
import { getS3Endpoint, S3_REGION, formatBytes } from '@filone/shared';
import { FILONE_STAGE } from '../env';

import type {
  ListObjectVersionsResponse,
  GetBucketResponse,
  ListAccessKeysResponse,
  BucketAnalyticsResponse,
} from '@filone/shared';
import { apiRequest } from '../lib/api.js';
import { formatDateTime } from '../lib/time.js';
import { useObjectActions } from '../lib/use-object-actions.js';
import { queryKeys } from '../lib/query-client.js';
import { batchPresign } from '../lib/use-presign.js';
import { parseListObjectVersionsResponse, executePresignedUrl } from '../lib/aurora-s3.js';

// ---------------------------------------------------------------------------
// Stat card component
// ---------------------------------------------------------------------------

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ size: number; className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-white px-5 py-4">
      <div className="flex size-10 items-center justify-center rounded-lg bg-zinc-100">
        <Icon size={20} className="text-zinc-500" />
      </div>
      <div>
        <p className="text-2xl font-semibold text-zinc-900">{value}</p>
        <p className="text-xs text-zinc-500">{label}</p>
      </div>
    </div>
  );
}

function BucketStatCards({
  analytics,
  accessKeyCount,
  accessKeysLoading,
}: {
  analytics: BucketAnalyticsResponse | undefined;
  accessKeyCount: number;
  accessKeysLoading: boolean;
}) {
  return (
    <div className="mb-6 grid grid-cols-3 gap-4">
      <StatCard
        icon={CubeIcon}
        label="Objects"
        value={analytics ? analytics.objectCount.toLocaleString() : '—'}
      />
      <StatCard
        icon={HardDrivesIcon}
        label="Storage used"
        value={analytics ? formatBytes(analytics.bytesUsed) : '—'}
      />
      <StatCard
        icon={KeyIcon}
        label="API keys"
        value={accessKeysLoading ? '—' : accessKeyCount.toLocaleString()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type BucketDetailPageProps = {
  bucketName: string;
  prefix?: string;
};

export function BucketDetailPage({ bucketName, prefix }: BucketDetailPageProps) {
  const s3Endpoint = getS3Endpoint(S3_REGION, FILONE_STAGE);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const currentPrefix = prefix ?? '';

  const setCurrentPrefix = useCallback(
    (newPrefix: string) => {
      void navigate({
        to: '/buckets/$bucketName',
        params: { bucketName },
        search: newPrefix ? { prefix: newPrefix } : {},
        replace: true,
      });
    },
    [navigate, bucketName],
  );

  // Bucket metadata
  const { data: bucketData } = useQuery({
    queryKey: queryKeys.bucket(bucketName),
    queryFn: () => apiRequest<GetBucketResponse>(`/buckets/${encodeURIComponent(bucketName)}`),
  });
  const bucket = bucketData?.bucket ?? null;

  // Objects (via presigned URL — versioned listing)
  const {
    data: objectsData,
    isPending: objectsLoading,
    isError: objectsIsError,
    error: objectsError,
  } = useQuery({
    queryKey: queryKeys.objects(bucketName),
    queryFn: async (): Promise<ListObjectVersionsResponse> => {
      const { items } = await batchPresign([{ op: 'listObjectVersions', bucket: bucketName }]);
      const response = await executePresignedUrl(items[0].url, items[0].method);
      return parseListObjectVersionsResponse(await response.text());
    },
  });
  const versions = objectsData?.versions ?? [];

  // Bucket analytics (object count + storage)
  const { data: analyticsData } = useQuery({
    queryKey: queryKeys.bucketAnalytics(bucketName),
    queryFn: () =>
      apiRequest<BucketAnalyticsResponse>(`/buckets/${encodeURIComponent(bucketName)}/analytics`),
  });

  // Access keys scoped to this bucket
  const { data: accessKeysData, isPending: accessKeysLoading } = useQuery({
    queryKey: queryKeys.bucketAccessKeys(bucketName),
    queryFn: () =>
      apiRequest<ListAccessKeysResponse>(`/access-keys?bucket=${encodeURIComponent(bucketName)}`),
  });
  const accessKeys = accessKeysData?.keys ?? [];

  const [addKeyOpen, setAddKeyOpen] = useState(false);

  const invalidateObjectsCache = useCallback(
    (key: string, versionId?: string) => {
      if (versionId) {
        queryClient.setQueryData<ListObjectVersionsResponse>(queryKeys.objects(bucketName), (old) =>
          old
            ? {
                ...old,
                versions: old.versions.filter((v) => !(v.key === key && v.versionId === versionId)),
              }
            : old,
        );
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.objects(bucketName) });
    },
    [queryClient, bucketName],
  );

  const objectActions = useObjectActions({ bucketName, onDeleted: invalidateObjectsCache });

  const invalidateAccessKeysCache = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
    void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
  }, [queryClient]);

  if (objectsLoading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading objects" size={32} />
      </div>
    );
  }

  if (objectsIsError) {
    return (
      <div className="p-6">
        <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {objectsError?.message ?? 'Failed to load objects'}
        </div>
      </div>
    );
  }

  const bucketRegion = bucket?.region ?? S3_REGION;

  return (
    <div className="p-6">
      <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />

      <div className="mt-2 mb-2 flex items-center justify-between">
        <Heading tag="h1" size="xl">
          {bucketName}
        </Heading>
        <Button
          variant="primary"
          icon={ArrowUpIcon}
          onClick={() =>
            void navigate({
              to: '/buckets/$bucketName/upload',
              params: { bucketName },
            })
          }
        >
          Upload object
        </Button>
      </div>

      {bucket && (
        <p className="mb-6 text-sm text-zinc-500">
          {bucketRegion} &bull; Created {formatDateTime(bucket.createdAt)}
        </p>
      )}

      {bucket && <BucketPropertiesCard bucket={bucket} />}

      <BucketStatCards
        analytics={analyticsData}
        accessKeyCount={accessKeys.length}
        accessKeysLoading={accessKeysLoading}
      />

      <Tabs>
        <TabList>
          <Tab>Objects</Tab>
          <Tab>Access</Tab>
        </TabList>

        <TabPanels>
          <TabPanel>
            <ObjectBrowser
              bucketName={bucketName}
              versions={versions}
              versioningEnabled={bucket?.versioning ?? false}
              currentPrefix={currentPrefix}
              onPrefixChange={setCurrentPrefix}
              onDownload={objectActions.downloadObject}
              downloading={objectActions.downloading}
              onDelete={objectActions.deleteObject}
            />
          </TabPanel>

          <TabPanel>
            <BucketAccessTab
              bucketName={bucketName}
              s3Endpoint={s3Endpoint}
              region={bucketRegion}
              accessKeys={accessKeys}
              accessKeysLoading={accessKeysLoading}
              onCreateOpen={() => setAddKeyOpen(true)}
            />
          </TabPanel>
        </TabPanels>
      </Tabs>

      <AddBucketKeyModal
        open={addKeyOpen}
        onClose={() => setAddKeyOpen(false)}
        bucketName={bucketName}
        onKeyAdded={invalidateAccessKeysCache}
      />
    </div>
  );
}
