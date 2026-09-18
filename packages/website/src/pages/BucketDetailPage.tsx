import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CloudArrowUpIcon } from '@phosphor-icons/react/dist/ssr';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { Heading } from '../components/Heading/Heading';
import { Button } from '../components/Button';
import { Tabs, TabList, Tab, TabPanels, TabPanel } from '../components/Tabs';
import { Breadcrumb } from '../components/Breadcrumb';
import { Alert } from '../components/Alert';
import { Skeleton } from '../components/Skeleton';
import { TableSkeleton, type SkeletonColumn } from '../components/Table/TableSkeleton';
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
import { useHasPermission } from '../lib/use-permissions.js';
import { usePermittedDialog } from '../lib/use-permitted-dialog.js';
import { useKeyActionScope } from '../lib/use-key-scope.js';
import { LIST_GC_TIME, LIST_STALE_TIME, queryKeys } from '../lib/query-client.js';
import { batchPresign } from '../lib/use-presign.js';
import { useOrgSlug } from '../lib/use-org-path.js';
import {
  parseListObjectVersionsResponse,
  parseListObjectsResponse,
  executePresignedUrl,
} from '../lib/aurora-s3.js';

function formatStorage(bytesUsed: number | undefined): string {
  if (bytesUsed === undefined) return '—';
  return formatBytes(bytesUsed);
}

/**
 * Object count for the tab label.
 *
 * A complete listing is the better source: it is exact, current, and counts the
 * same things the table and its selection do. Analytics cannot match it on
 * either front. It comes from `getBucketUsageMetrics` at a one-day interval, so
 * it is the most recent daily sample rather than a live count and lags anything
 * uploaded or deleted since, and being a usage metric it does not count keys
 * whose current version is a delete marker, which the listing does.
 *
 * Analytics is still right for a truncated listing, where the browser genuinely
 * cannot know the total, so it is used only there.
 */
function displayObjectCount(
  analytics: BucketAnalyticsResponse | undefined,
  versions: S3ObjectVersion[],
  listingTruncated: boolean,
): number {
  if (!listingTruncated) return countObjects(versions);
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
 * The overview's own placeholder, shown while the bucket metadata is in flight.
 *
 * It mirrors the real block it stands in for: one line of meta, then the same
 * responsive grid of three property cards at the same height. Without it the
 * heading sat directly on top of the tabs and everything below jumped down a
 * card's height the moment metadata landed.
 */
function BucketOverviewSkeleton() {
  return (
    <div role="status" aria-label="Loading bucket details">
      <Skeleton className="mb-6 h-4 w-72 max-w-full" />
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {['versioning', 'object-lock', 'retention'].map((property) => (
          <Skeleton key={property} className="h-[68px] rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/**
 * The page's four reads, grouped so the component body stays about layout. The
 * objects query is gated on bucket metadata because the versioning flag decides
 * which listing operation to use.
 */
function useBucketQueries(bucketName: string, region: S3Region, mayListKeys: boolean) {
  // Cached the way the list pages are (FIL-1078): stepping into a bucket, back
  // out and in again repaints from cache instead of blanking to a placeholder
  // each time. Every write to a bucket invalidates these keys, so nothing here
  // outlives the user's own edit.
  const bucketQuery = useQuery({
    queryKey: queryKeys.bucket(bucketName, region),
    staleTime: LIST_STALE_TIME,
    gcTime: LIST_GC_TIME,
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
    staleTime: LIST_STALE_TIME,
    gcTime: LIST_GC_TIME,
    queryFn: () => fetchObjectListing(region, bucketName, bucket),
  });

  const analyticsQuery = useQuery({
    queryKey: queryKeys.bucketAnalytics(bucketName, region),
    staleTime: LIST_STALE_TIME,
    gcTime: LIST_GC_TIME,
    queryFn: () => {
      const params = new URLSearchParams({ region });
      return apiRequest<BucketAnalyticsResponse>(
        `/buckets/${encodeURIComponent(bucketName)}/analytics?${params.toString()}`,
      );
    },
  });

  // Access keys are region-scoped, so the region is part of the filter: a key
  // from another region, even one scoped to all buckets, cannot operate on this
  // bucket. The server narrows the list to the caller's own keys unless they
  // hold `keys.manage_all`; without `keys.manage_own` it refuses the request, so
  // it is not made.
  const accessKeysQuery = useQuery({
    queryKey: queryKeys.bucketAccessKeys(bucketName, region),
    enabled: mayListKeys,
    staleTime: LIST_STALE_TIME,
    gcTime: LIST_GC_TIME,
    queryFn: () => {
      const params = new URLSearchParams({ bucket: bucketName, region });
      return apiRequest<ListAccessKeysResponse>(`/access-keys?${params.toString()}`);
    },
  });

  return {
    bucket,
    bucketQuery,
    objectsQuery,
    analyticsQuery,
    accessKeysQuery,
    // Read through the permission, not just `enabled`: react-query keeps
    // serving a disabled query's cached rows, so a mid-session downgrade would
    // leave the key metadata in the tab and its count until the page reloaded.
    accessKeys: mayListKeys ? (accessKeysQuery.data?.keys ?? []) : [],
    // A disabled query stays pending forever, which would spin the tab's
    // spinner for a role that is never going to get an answer.
    accessKeysLoading: mayListKeys && accessKeysQuery.isPending,
  };
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

// Mirrors ObjectBrowser's columns so the placeholder holds the same shape as the
// table it stands in for. The Version and Status pair is versioning-only, and
// versioning is not known until the bucket metadata lands, so the skeleton shows
// the columns every bucket has rather than guessing at two that may not appear.
const OBJECT_SKELETON_COLUMNS: SkeletonColumn[] = [
  { label: 'Name' },
  { label: 'Size' },
  { label: 'Last Modified' },
  {},
];

/**
 * The Objects tab's body: the listing, or a table-shaped placeholder while it
 * loads. Extracted so the page component stays about layout, and so the
 * loading branch sits next to the table it stands in for.
 */
function ObjectsPanel({
  loading,
  objectActions,
  mayUpload,
  mayDelete,
  ...browser
}: {
  loading: boolean;
  bucketName: string;
  region: S3Region;
  versions: S3ObjectVersion[];
  versioningEnabled: boolean;
  currentPrefix: string;
  onPrefixChange: (prefix: string) => void;
  objectActions: ReturnType<typeof useObjectActions>;
  mayUpload: boolean;
  mayDelete: boolean;
  listingTruncated: boolean;
  totalObjectCount: number | undefined;
}) {
  if (loading) {
    return <TableSkeleton columns={OBJECT_SKELETON_COLUMNS} aria-label="Loading objects" />;
  }

  return (
    <ObjectBrowser
      {...browser}
      onDownload={objectActions.downloadObject}
      downloading={objectActions.downloading}
      canUpload={mayUpload}
      onDelete={mayDelete ? objectActions.deleteObject : undefined}
      onBulkDelete={mayDelete ? objectActions.deleteObjects : undefined}
    />
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
  const orgSlug = useOrgSlug();
  const queryClient = useQueryClient();
  const currentPrefix = prefix ?? '';
  const mayUpload = useHasPermission('objects.write');
  const mayDelete = useHasPermission('objects.delete');
  const { mayList: mayListKeys } = useKeyActionScope();
  const mayCreateKeys = useHasPermission('keys.create');

  const setCurrentPrefix = useCallback(
    (newPrefix: string) => {
      void navigate({
        to: '/$orgSlug/buckets/$bucketName',
        params: { orgSlug, bucketName },
        search: { region, ...(newPrefix ? { prefix: newPrefix } : {}) },
        replace: true,
      });
    },
    [navigate, orgSlug, bucketName, region],
  );

  const {
    bucket,
    bucketQuery,
    objectsQuery,
    analyticsQuery,
    accessKeysQuery,
    accessKeys,
    accessKeysLoading,
  } = useBucketQueries(bucketName, region, mayListKeys);
  const { versions, isTruncated } = readListing(objectsQuery.data);
  const analyticsData = analyticsQuery.data;

  // The Add key modal goes with the `keys.create` control inside the tab.
  const [addKeyOpen, setAddKeyOpen] = usePermittedDialog(false, mayCreateKeys);

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
            and there is nothing to empty. Each also goes with its permission:
            emptying the bucket is a bulk `objects.delete`, uploading is
            `objects.write`, and a role holding neither gets no action bar at
            all. The cloud glyph leads the label, echoing that empty state's
            icon. */}
        {versions.length > 0 && (mayDelete || mayUpload) && (
          <div className="flex items-center gap-2">
            {mayDelete && (
              <EmptyBucketAction
                bucketName={bucketName}
                region={region}
                totalObjectCount={analyticsData?.objectCount}
                onFinished={refreshAfterBulkDelete}
              />
            )}
            {mayUpload && (
              <Button
                id="upload-object-button"
                variant="primary"
                size="sm"
                icon={CloudArrowUpIcon}
                iconSize={18}
                iconPosition="left"
                onClick={() =>
                  void navigate({
                    to: '/$orgSlug/buckets/$bucketName/upload',
                    params: { orgSlug, bucketName },
                    search: { region },
                  })
                }
              >
                Upload object
              </Button>
            )}
          </div>
        )}
      </div>

      {bucketQuery.isPending ? (
        <BucketOverviewSkeleton />
      ) : (
        <BucketOverview bucket={bucket} region={region} bytesUsed={analyticsData?.bytesUsed} />
      )}

      <Tabs>
        <TabList>
          {/* The count waits for the listing rather than counting an empty
              array: "Objects (0)" on a bucket that turns out to hold hundreds is
              a worse answer than no number yet, and it is the same rule the API
              Keys tab beside it already follows. */}
          <Tab
            testId="bucket-objects-tab"
            count={
              objectsQuery.isPending
                ? undefined
                : displayObjectCount(analyticsData, versions, isTruncated)
            }
          >
            Objects
          </Tab>
          {/* Absent, not empty, for a role that cannot list keys: an "API Keys
              (0)" tab reads as an org with no keys rather than a view this
              caller does not get. */}
          {mayListKeys && (
            <Tab testId="bucket-keys-tab" count={accessKeysLoading ? undefined : accessKeys.length}>
              API Keys
            </Tab>
          )}
        </TabList>

        <TabPanels>
          <TabPanel>
            <ObjectsPanel
              loading={objectsQuery.isPending}
              bucketName={bucketName}
              region={region}
              versions={versions}
              versioningEnabled={bucket?.versioning ?? false}
              currentPrefix={currentPrefix}
              onPrefixChange={setCurrentPrefix}
              objectActions={objectActions}
              mayUpload={mayUpload}
              mayDelete={mayDelete}
              listingTruncated={isTruncated}
              totalObjectCount={analyticsData?.objectCount}
            />
          </TabPanel>

          {mayListKeys && (
            <TabPanel>
              <BucketAccessTab
                bucketName={bucketName}
                s3Endpoint={s3Endpoint}
                region={region}
                accessKeys={accessKeys}
                accessKeysLoading={accessKeysLoading}
                accessKeysError={accessKeysQuery.isError}
                accessKeysErrorMessage={accessKeysQuery.error?.message}
                onCreateOpen={() => setAddKeyOpen(true)}
              />
            </TabPanel>
          )}
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
