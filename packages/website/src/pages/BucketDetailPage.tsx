import { useCallback, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CloudArrowUpIcon } from '@phosphor-icons/react/dist/ssr';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { Heading } from '../components/Heading/Heading';
import { Button } from '../components/Button';
import { Tabs, TabList, Tab, TabPanels, TabPanel } from '../components/Tabs';
import { Breadcrumb } from '../components/Breadcrumb';
import { Alert } from '../components/Alert';
import { Spinner } from '../components/Spinner';
import { AddBucketKeyModal } from '../components/AddBucketKeyModal';
import { BucketPropertyCards } from '../components/BucketPropertiesCard';
import { ObjectBrowser, countObjects } from '../components/ObjectBrowser';
import { EmptyBucketAction } from '../components/EmptyBucketAction';
import { BucketAccessTab } from '../components/BucketAccessTab';
import type { S3ObjectVersion, S3Region } from '@filone/shared';
import { getS3Endpoint, formatBytes } from '@filone/shared';
import { FILONE_STAGE } from '../env';

import type {
  Bucket,
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
import {
  parseListObjectVersionsResponse,
  parseListObjectsResponse,
  executePresignedUrl,
} from '../lib/aurora-s3.js';

function formatStorage(bytesUsed: number | undefined): string {
  if (bytesUsed === undefined) return '—';
  return formatBytes(bytesUsed);
}

// Analytics has the full-bucket count; the listing is a single page (max 1000
// entries) so counting it undercounts large buckets. Fall back to the listing
// count only while analytics is loading (or if it fails).
function displayObjectCount(
  analytics: BucketAnalyticsResponse | undefined,
  versions: S3ObjectVersion[],
): number {
  return analytics?.objectCount ?? countObjects(versions);
}

// Fetch the object listing via presigned URL. Versioned buckets use
// ListObjectVersions so version history is available inline; non-versioned
// buckets use ListObjectsV2, which only ever returns live objects (never delete
// markers). Both paths are normalized to the ListObjectVersionsResponse shape so
// the cache and invalidation logic stay identical.
async function fetchObjectListing(
  region: S3Region,
  bucketName: string,
  bucket: Bucket | null,
): Promise<ListObjectVersionsResponse> {
  if (bucket?.versioning) {
    const { items } = await batchPresign(region, [
      { op: 'listObjectVersions', bucket: bucketName },
    ]);
    const response = await executePresignedUrl(items[0].url, items[0].method);
    return parseListObjectVersionsResponse(await response.text());
  }

  const { items } = await batchPresign(region, [{ op: 'listObjects', bucket: bucketName }]);
  const response = await executePresignedUrl(items[0].url, items[0].method);
  const { objects, isTruncated } = parseListObjectsResponse(await response.text());
  return {
    versions: objects.map((obj) => ({
      ...obj,
      versionId: '',
      isLatest: true,
      isDeleteMarker: false,
    })),
    isTruncated,
  };
}

function removeVersionFromListing(
  old: ListObjectVersionsResponse | undefined,
  key: string,
  versionId: string,
): ListObjectVersionsResponse | undefined {
  if (!old) return old;
  return {
    ...old,
    versions: old.versions.filter((v) => !(v.key === key && v.versionId === versionId)),
  };
}

/**
 * Unpack the objects query into the two values the browser needs. `isTruncated`
 * matters: the listing is a single page, so anything past it is not loaded and
 * selection cannot reach it.
 */
function readListing(objectsData: ListObjectVersionsResponse | undefined): {
  versions: S3ObjectVersion[];
  isTruncated: boolean;
} {
  return {
    versions: objectsData?.versions ?? [],
    isTruncated: objectsData?.isTruncated ?? false,
  };
}

function BucketOverview({
  bucket,
  region,
  bytesUsed,
}: {
  bucket: Bucket | null;
  region: S3Region;
  bytesUsed: number | undefined;
}) {
  if (!bucket) return null;

  return (
    <>
      <p className="mb-6 text-sm">
        <span className="text-zinc-700">{region}</span>
        <span className="mx-2 text-zinc-400">&bull;</span>
        <span className="text-xs text-zinc-500">{formatStorage(bytesUsed)} used</span>
        <span className="mx-2 text-zinc-400">&bull;</span>
        <span className="text-xs text-zinc-500">Created {formatDateTime(bucket.createdAt)}</span>
      </p>
      {/* Responsive rather than a fixed three columns: at 375px three columns
          crushed the cards, and with four of them the fourth was orphaned at a
          third of the width on a row of its own. */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <BucketPropertyCards bucket={bucket} />
      </div>
    </>
  );
}

/**
 * The page's four reads, grouped so the component body stays about layout. The
 * objects query is gated on bucket metadata because the versioning flag decides
 * which listing operation to use.
 */
function useBucketQueries(bucketName: string, region: S3Region) {
  const bucketQuery = useQuery({
    queryKey: queryKeys.bucket(bucketName, region),
    queryFn: () => {
      const params = new URLSearchParams({ region });
      return apiRequest<GetBucketResponse>(
        `/buckets/${encodeURIComponent(bucketName)}?${params.toString()}`,
      );
    },
  });
  const bucket = bucketQuery.data?.bucket ?? null;

  const objectsQuery = useQuery({
    queryKey: queryKeys.objects(bucketName, region),
    enabled: bucketQuery.data !== undefined,
    queryFn: () => fetchObjectListing(region, bucketName, bucket),
  });

  const analyticsQuery = useQuery({
    queryKey: queryKeys.bucketAnalytics(bucketName, region),
    queryFn: () => {
      const params = new URLSearchParams({ region });
      return apiRequest<BucketAnalyticsResponse>(
        `/buckets/${encodeURIComponent(bucketName)}/analytics?${params.toString()}`,
      );
    },
  });

  // Access keys are region-scoped, so the region is part of the filter: a key
  // from another region, even one scoped to all buckets, cannot operate on this
  // bucket.
  const accessKeysQuery = useQuery({
    queryKey: queryKeys.bucketAccessKeys(bucketName, region),
    queryFn: () => {
      const params = new URLSearchParams({ bucket: bucketName, region });
      return apiRequest<ListAccessKeysResponse>(`/access-keys?${params.toString()}`);
    },
  });

  return { bucket, bucketQuery, objectsQuery, analyticsQuery, accessKeysQuery };
}

function BucketErrorState({
  bucketName,
  error,
  fallback,
}: {
  bucketName: string;
  error: Error | null;
  fallback: string;
}) {
  return (
    <div className="px-5 pt-6 sm:px-8 lg:px-10 lg:pt-10">
      <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />
      <div className="mt-4">
        <Alert variant="red" description={error?.message ?? fallback} />
      </div>
    </div>
  );
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

  const { bucket, bucketQuery, objectsQuery, analyticsQuery, accessKeysQuery } = useBucketQueries(
    bucketName,
    region,
  );
  const { versions, isTruncated } = readListing(objectsQuery.data);
  const analyticsData = analyticsQuery.data;
  const accessKeys = accessKeysQuery.data?.keys ?? [];

  const [addKeyOpen, setAddKeyOpen] = useState(false);

  const refreshAfterBulkDelete = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.objects(bucketName, region) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bucketAnalytics(bucketName, region) });
  }, [queryClient, bucketName, region]);

  const invalidateObjectsCache = useCallback(
    (key: string, versionId?: string) => {
      if (versionId) {
        queryClient.setQueryData<ListObjectVersionsResponse>(
          queryKeys.objects(bucketName, region),
          (old) => removeVersionFromListing(old, key, versionId),
        );
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.objects(bucketName, region) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.bucketAnalytics(bucketName, region),
      });
    },
    [queryClient, bucketName, region],
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

  // The objects query is gated on bucket metadata, so a metadata failure must be
  // surfaced here — otherwise the disabled objects query stays pending forever.
  if (bucketQuery.isError) {
    return (
      <BucketErrorState
        bucketName={bucketName}
        error={bucketQuery.error}
        fallback="Failed to load bucket"
      />
    );
  }

  if (objectsQuery.isPending) {
    return (
      <div className="flex items-center justify-center p-16">
        <Spinner ariaLabel="Loading objects" size={32} />
      </div>
    );
  }

  if (objectsQuery.isError) {
    return (
      <BucketErrorState
        bucketName={bucketName}
        error={objectsQuery.error}
        fallback="Failed to load objects"
      />
    );
  }

  return (
    <div className="px-5 pt-6 sm:px-8 lg:px-10 lg:pt-10">
      <Breadcrumb items={[{ label: 'Buckets', href: '/buckets' }, { label: bucketName }]} />

      <div className="mt-4 mb-2 flex items-center justify-between">
        <Heading tag="h1" size="xl">
          {bucketName}
        </Heading>
        {/* Both hidden while the bucket is empty: the empty state carries the
            sole upload CTA then, so two identical primary actions never compete,
            and there is nothing to empty. The cloud glyph leads the label,
            echoing that empty state's icon. */}
        {versions.length > 0 && (
          <div className="flex items-center gap-2">
            <EmptyBucketAction
              bucketName={bucketName}
              region={region}
              totalObjectCount={analyticsData?.objectCount}
              onFinished={refreshAfterBulkDelete}
            />
            <Button
              id="upload-object-button"
              variant="primary"
              size="sm"
              icon={CloudArrowUpIcon}
              iconSize={18}
              iconPosition="left"
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
        )}
      </div>

      <BucketOverview bucket={bucket} region={region} bytesUsed={analyticsData?.bytesUsed} />

      <Tabs>
        <TabList>
          <Tab testId="bucket-objects-tab">
            Objects ({displayObjectCount(analyticsData, versions).toLocaleString()})
          </Tab>
          <Tab testId="bucket-keys-tab">
            API Keys{!accessKeysQuery.isPending && ` (${accessKeys.length.toLocaleString()})`}
          </Tab>
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
              onBulkDelete={objectActions.deleteObjects}
              listingTruncated={isTruncated}
              totalObjectCount={analyticsData?.objectCount}
            />
          </TabPanel>

          <TabPanel>
            <BucketAccessTab
              bucketName={bucketName}
              s3Endpoint={s3Endpoint}
              region={region}
              accessKeys={accessKeys}
              accessKeysLoading={accessKeysQuery.isPending}
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
