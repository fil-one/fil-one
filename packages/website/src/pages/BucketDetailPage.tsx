import { useCallback, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpIcon } from '@phosphor-icons/react/dist/ssr';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { Heading } from '../components/Heading/Heading';
import { Button } from '../components/Button';
import { Tabs, TabList, Tab, TabPanels, TabPanel } from '../components/Tabs';
import { Breadcrumb } from '../components/Breadcrumb';
import { Alert } from '../components/Alert';
import { Spinner } from '../components/Spinner';
import { AddBucketKeyModal } from '../components/AddBucketKeyModal';
import { BucketPropertyCards } from '../components/BucketPropertiesCard';
import { ObjectBrowser } from '../components/ObjectBrowser';
import { BucketAccessTab } from '../components/BucketAccessTab';
import type { S3Region } from '@filone/shared';
import { getS3Endpoint, formatBytes } from '@filone/shared';
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

function formatStorage(bytesUsed: number | undefined): string {
  if (bytesUsed === undefined) return '—';
  return formatBytes(bytesUsed);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type BucketDetailPageProps = {
  bucketName: string;
  prefix?: string;
  region: S3Region;
};

export function BucketDetailPage({ bucketName, prefix, region }: BucketDetailPageProps) {
  const s3Endpoint = getS3Endpoint(region, FILONE_STAGE);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const currentPrefix = prefix ?? '';

  const setCurrentPrefix = useCallback(
    (newPrefix: string) => {
      void navigate({
        to: '/buckets/$bucketName',
        params: { bucketName },
        search: { region, ...(newPrefix ? { prefix: newPrefix } : {}) },
        replace: true,
      });
    },
    [navigate, bucketName, region],
  );

  // Bucket metadata
  const { data: bucketData } = useQuery({
    queryKey: queryKeys.bucket(bucketName, region),
    queryFn: () => {
      const params = new URLSearchParams({ region });
      return apiRequest<GetBucketResponse>(
        `/buckets/${encodeURIComponent(bucketName)}?${params.toString()}`,
      );
    },
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
      const { items } = await batchPresign(region, [
        { op: 'listObjectVersions', bucket: bucketName },
      ]);
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

  const objectActions = useObjectActions({
    bucketName,
    region,
    onDeleted: invalidateObjectsCache,
  });

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
      <div className="px-10 pt-10">
        <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />
        <div className="mt-4">
          <Alert variant="red" description={objectsError?.message ?? 'Failed to load objects'} />
        </div>
      </div>
    );
  }

  return (
    <div className="px-10 pt-10">
      <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />

      <div className="mt-4 mb-2 flex items-center justify-between">
        <Heading tag="h1" size="xl">
          {bucketName}
        </Heading>
        <Button
          variant="primary"
          size="md"
          icon={ArrowUpIcon}
          onClick={() =>
            void navigate({
              to: '/buckets/$bucketName/upload',
              params: { bucketName },
              search: { region },
            })
          }
        >
          Upload object
        </Button>
      </div>

      {bucket && (
        <p className="mb-6 text-sm">
          <span className="text-zinc-700">{region}</span>
          <span className="mx-2 text-zinc-400">&bull;</span>
          <span className="text-xs text-zinc-500">
            {formatStorage(analyticsData?.bytesUsed)} used
          </span>
          <span className="mx-2 text-zinc-400">&bull;</span>
          <span className="text-xs text-zinc-500">Created {formatDateTime(bucket.createdAt)}</span>
        </p>
      )}

      {bucket && (
        <div className="mb-6 grid grid-cols-3 gap-4">
          <BucketPropertyCards bucket={bucket} />
        </div>
      )}

      <Tabs>
        <TabList>
          <Tab>Objects ({versions.length.toLocaleString()})</Tab>
          <Tab>API Keys{!accessKeysLoading && ` (${accessKeys.length.toLocaleString()})`}</Tab>
        </TabList>

        <TabPanels>
          <TabPanel>
            <ObjectBrowser
              bucketName={bucketName}
              region={region}
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
              region={region}
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
        region={region}
        onKeyAdded={invalidateAccessKeysCache}
      />
    </div>
  );
}
