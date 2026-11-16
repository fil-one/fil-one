import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { Tabs, TabList, Tab, TabPanels, TabPanel } from '../components/Tabs';
import { Breadcrumb } from '../components/Breadcrumb';
import { Alert } from '../components/Alert';
import { Skeleton } from '../components/Skeleton';
import { AddBucketKeyModal } from '../components/AddBucketKeyModal';
import { countObjects } from '../components/ObjectBrowser';
import { ObjectsPanel } from './BucketObjectsPanel';
import { useBucketTabs } from '../lib/use-bucket-tabs.js';
import { BucketAccessTab } from '../components/BucketAccessTab';
import { BucketPolicyTab } from '../components/BucketPolicyTab';
import { useBucketColdStorage } from '../components/BucketColdStorage';
import { BucketPageHeader } from './BucketPageHeader';
import { useSimulatedAnalytics } from '../lib/cold-storage-prototype.js';
import type { S3ObjectVersion, S3Region } from '@filone/shared';
import { getS3Endpoint, formatBytes } from '@filone/shared';
import { FILONE_STAGE } from '../env';

import type {
  BucketDetails,
  ListObjectVersionsResponse,
  GetBucketResponse,
  ListAccessKeysResponse,
  BucketAnalyticsResponse,
} from '@filone/shared';
import { supportsIamMethods } from '../lib/access-model.js';
import { apiRequest } from '../lib/api.js';
import { useObjectActions } from '../lib/use-object-actions.js';
import { useHasPermission, usePermissions } from '../lib/use-permissions.js';
import { usePermittedDialog } from '../lib/use-permitted-dialog.js';
import { useKeyActionScope } from '../lib/use-key-scope.js';
import { LIST_GC_TIME, LIST_STALE_TIME, queryKeys } from '../lib/query-client.js';
import { fetchObjectListing } from '../lib/object-listing.js';
import { describeRetention } from '../lib/retention.js';

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
  bucket: BucketDetails | null;
  region: S3Region;
  bytesUsed: number | undefined;
}) {
  // Cold storage prototype: the demo bucket shows its made-up size.
  const simulated = useSimulatedAnalytics(bucket?.bucketName ?? '', region);
  if (!bucket) return null;

  // The one setting that changes what can be done in the table: retention
  // blocks deletes. Bucket details lists every setting, on or off.
  const retention = bucket.objectLockEnabled
    ? describeRetention(
        bucket.defaultRetention,
        bucket.retentionDuration,
        bucket.retentionDurationType,
      )
    : null;
  return (
    <p className="mb-6 text-sm">
      <span className="text-zinc-700">{region}</span>
      <span className="mx-2 text-zinc-400">&bull;</span>
      <span className="text-xs text-zinc-500">
        {formatStorage(simulated?.bytesUsed ?? bytesUsed)} used
      </span>
      {retention && (
        <>
          <span className="mx-2 text-zinc-400">&bull;</span>
          <span className="text-xs text-zinc-500">{retention}</span>
        </>
      )}
    </p>
  );
}

/**
 * The overview's own placeholder, shown while the bucket metadata is in flight:
 * the one line of meta.
 */
function BucketOverviewSkeleton() {
  return (
    <div role="status" aria-label="Loading bucket details">
      <Skeleton className="mb-6 h-4 w-72 max-w-full" />
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
      <div className="mt-4" data-testid="bucket-error">
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
  const mayUpload = useHasPermission('objects.write');
  const mayDelete = useHasPermission('objects.delete');
  const { mayList: mayListKeys } = useKeyActionScope();
  const mayCreateKeys = useHasPermission('keys.create');
  const { isPending: permissionsLoading } = usePermissions();
  // The policy tab exists where a policy can: a region serving the `iam`
  // access model, for a role that may edit one. Reading takes the same
  // permission as editing, so the tab is absent rather than read-only.
  const isPolicyTabVisible =
    useHasPermission('buckets.policy_manage') && supportsIamMethods(region);

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
  // Controlled so the empty bucket's View API keys button can switch tabs.
  const tabs = useBucketTabs({ hasKeysTab: mayListKeys, hasPolicyTab: isPolicyTabVisible });
  // Each tab's count, undefined until its list has answered
  const objectCount = objectsQuery.isPending
    ? undefined
    : displayObjectCount(analyticsData, versions, isTruncated);
  const keyCount = accessKeysLoading ? undefined : accessKeys.length;

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
  // Cold storage prototype: files freeze one by one, so the bucket itself
  // never turns read-only; frozen files lock their own downloads.
  const cold = useBucketColdStorage(bucketName, region, currentPrefix);

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

      <BucketPageHeader
        bucketName={bucketName}
        bucket={bucket}
        region={region}
        analytics={analyticsData}
        hasObjects={versions.length > 0}
        mayDelete={mayDelete}
        mayUpload={mayUpload}
        onEmptied={refreshAfterBulkDelete}
        coldMenuActions={cold.menuActions}
        onRestoreFiles={cold.onRestoreFiles}
      />

      {bucketQuery.isPending ? (
        <BucketOverviewSkeleton />
      ) : (
        <BucketOverview bucket={bucket} region={region} bytesUsed={analyticsData?.bytesUsed} />
      )}

      <Tabs selectedIndex={tabs.selectedIndex} onChange={tabs.selectTabAt}>
        <TabList>
          {/* The count waits for the listing rather than counting an empty
              array: "Objects (0)" on a bucket that turns out to hold hundreds is
              a worse answer than no number yet, and it is the same rule the API
              Keys tab beside it already follows. */}
          <Tab testId="bucket-objects-tab" count={objectCount}>
            Objects
          </Tab>
          {/* Absent, not empty, for a role that cannot list keys: an "API Keys
              (0)" tab reads as an org with no keys rather than a view this
              caller does not get. */}
          {mayListKeys && (
            <Tab ref={tabs.keysTabRef} testId="bucket-keys-tab" count={keyCount}>
              API Keys
            </Tab>
          )}
          {/* Headless UI pairs tabs to panels by order, so this and its panel
              below sit behind the identical condition. */}
          {isPolicyTabVisible && <Tab testId="bucket-policy-tab">Policy</Tab>}
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
              activeAccessKeyCount={accessKeys.filter((key) => key.status !== 'expired').length}
              accessKeysLoading={accessKeysLoading}
              accessKeysFailed={accessKeysQuery.isError}
              permissionsLoading={permissionsLoading}
              mayCreateKeys={mayCreateKeys}
              onAddKeyOpenChange={setAddKeyOpen}
              onShowKeys={tabs.showKeysTab}
              listingTruncated={isTruncated}
              coldStorage={cold.objectColdStorage}
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
          {isPolicyTabVisible && (
            <TabPanel>
              <BucketPolicyTab bucketName={bucketName} region={region} />
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
      {cold.overlays}
    </div>
  );
}
