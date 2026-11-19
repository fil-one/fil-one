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
import { AddBucketKeyModal } from '../components/AddBucketKeyModal';
import { BucketPropertyCards } from '../components/BucketPropertiesCard';
import { countObjects } from '../components/ObjectBrowser';
import { ObjectsPanel } from './BucketObjectsPanel';
import { useBucketTabs } from '../lib/use-bucket-tabs.js';
import { EmptyBucketAction } from '../components/EmptyBucketAction';
import { BucketAccessTab } from '../components/BucketAccessTab';
import { BucketPolicyTab } from '../components/BucketPolicyTab';
import type { S3Region } from '@filone/shared';
import { getS3Endpoint, formatBytes } from '@filone/shared';
import { FILONE_STAGE } from '../env';

import type {
  BucketDetails,
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
import type { ObjectListingPage } from '../lib/object-listing.js';
import { removeVersionFromPage } from '../lib/object-listing.js';
import { useFolderSearch } from '../lib/use-folder-search.js';
import { useObjectListing } from '../lib/use-object-listing.js';

function formatStorage(bytesUsed: number | undefined): string {
  if (bytesUsed === undefined) return '—';
  return formatBytes(bytesUsed);
}

/**
 * Object count for the tab label.
 *
 * The listing is exact and current, so it is the better source whenever it
 * covers the whole bucket: the root, on one page, with no folders. Anywhere
 * else it covers one page of one folder and analytics is the only total.
 * Analytics comes from `getBucketUsageMetrics` at a one-day interval, so it lags
 * recent uploads and deletes, and as a usage metric it does not count keys whose
 * current version is a delete marker, which the listing does.
 */
function displayObjectCount(
  analytics: BucketAnalyticsResponse | undefined,
  page: ObjectListingPage,
  coversBucket: boolean,
): number | undefined {
  return coversBucket ? countObjects(page.versions) : analytics?.objectCount;
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
  if (!bucket) return null;

  return (
    <>
      <p className="mb-6 text-sm">
        <span className="text-zinc-700">{region}</span>
        <span className="mx-2 text-zinc-400">&bull;</span>
        <span className="text-xs text-zinc-500">{formatStorage(bytesUsed)} used</span>
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
 * objects listing is gated on bucket metadata because the versioning flag decides
 * which listing operation to use.
 */
function useBucketQueries({
  bucketName,
  region,
  prefix,
  search,
  mayListKeys,
}: {
  bucketName: string;
  region: S3Region;
  prefix: string;
  search: string;
  mayListKeys: boolean;
}) {
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

  const objects = useObjectListing({
    bucketName,
    region,
    versioning: bucket?.versioning ?? false,
    prefix,
    search,
    enabled: bucketQuery.data !== undefined,
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
    objects,
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

/**
 * The action bar beside the bucket heading. Both actions are hidden while the
 * bucket is empty: the empty state carries the sole upload CTA then, so two
 * identical primary actions never compete, and there is nothing to empty. Each
 * also goes with its permission: emptying the bucket is a bulk
 * `objects.delete`, uploading is `objects.write`, and a role holding neither
 * gets no action bar at all. The cloud glyph leads the label, echoing that
 * empty state's icon.
 */
export function BucketHeaderActions({
  bucketName,
  region,
  hasObjects,
  mayDelete,
  mayUpload,
  totalObjectCount,
  onEmptied,
  onUpload,
}: {
  bucketName: string;
  region: S3Region;
  hasObjects: boolean;
  mayDelete: boolean;
  mayUpload: boolean;
  totalObjectCount: number | undefined;
  onEmptied: () => void;
  onUpload: () => void;
}) {
  if (!hasObjects || !(mayDelete || mayUpload)) return null;
  return (
    <div className="flex items-center gap-2">
      {mayDelete && (
        <EmptyBucketAction
          bucketName={bucketName}
          region={region}
          totalObjectCount={totalObjectCount}
          onFinished={onEmptied}
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
          onClick={onUpload}
        >
          Upload object
        </Button>
      )}
    </div>
  );
}

const EMPTY_PAGE: ObjectListingPage = { versions: [], folders: [] };

/**
 * What the page needs from the folder listing, worked out in one place so the
 * component stays about layout.
 */
function describeListing(
  objects: ReturnType<typeof useObjectListing>,
  currentPrefix: string,
  search: string,
) {
  const page = objects.page ?? EMPTY_PAGE;
  const { query } = objects;
  const isWholeRoot = currentPrefix === '' && search === '';
  return {
    page,
    // Inside a folder, past the first page, or mid-search, the bucket has
    // objects by definition: a search box only shows over objects.
    hasObjects:
      !isWholeRoot || !objects.isFirstPage || page.versions.length > 0 || page.folders.length > 0,
    // The root, unsearched, on one page, with no folders: the listing is the whole bucket.
    coversBucket:
      isWholeRoot && objects.isFirstPage && !objects.hasNext && page.folders.length === 0,
    listingError: query.isError
      ? { message: query.error.message, onRetry: () => void query.refetch() }
      : undefined,
    paging: {
      rangeStart: objects.rangeStart,
      rangeEnd: objects.rangeEnd,
      hasPrevious: objects.hasPrevious,
      hasNext: objects.hasNext,
      onPrevious: objects.goToPreviousPage,
      onNext: objects.goToNextPage,
      changing: objects.isChangingPage,
    },
  };
}

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
  const folderSearch = useFolderSearch(currentPrefix);
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
    objects,
    analyticsQuery,
    accessKeysQuery,
    accessKeys,
    accessKeysLoading,
  } = useBucketQueries({
    bucketName,
    region,
    prefix: currentPrefix,
    search: folderSearch.settledText,
    mayListKeys,
  });
  const objectsQuery = objects.query;
  const listing = describeListing(objects, currentPrefix, folderSearch.settledText);
  const { page } = listing;
  const analyticsData = analyticsQuery.data;

  // The Add key modal goes with the `keys.create` control inside the tab.
  const [addKeyOpen, setAddKeyOpen] = usePermittedDialog(false, mayCreateKeys);
  // Controlled so the empty bucket's View API keys button can switch tabs.
  const tabs = useBucketTabs({ hasKeysTab: mayListKeys, hasPolicyTab: isPolicyTabVisible });
  // Each tab's count, undefined until its list has answered
  const objectCount = objectsQuery.isPending
    ? undefined
    : displayObjectCount(analyticsData, page, listing.coversBucket);
  const keyCount = accessKeysLoading ? undefined : accessKeys.length;

  const refreshAfterBulkDelete = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.objects(bucketName, region) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bucketAnalytics(bucketName, region) });
  }, [queryClient, bucketName, region]);

  const invalidateObjectsCache = useCallback(
    (key: string, versionId?: string) => {
      if (versionId) {
        queryClient.setQueriesData<ObjectListingPage>(
          { queryKey: queryKeys.objects(bucketName, region) },
          (old) => removeVersionFromPage(old, key, versionId),
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

  // A later page that fails keeps the page around it, so the reader can step
  // back or retry; only a folder that cannot be listed at all replaces the page.
  if (objectsQuery.isError && objects.isFirstPage) {
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
        <Heading id="bucket-detail-heading" tag="h1" size="xl">
          {bucketName}
        </Heading>
        <BucketHeaderActions
          bucketName={bucketName}
          region={region}
          hasObjects={listing.hasObjects}
          mayDelete={mayDelete}
          mayUpload={mayUpload}
          totalObjectCount={analyticsData?.objectCount}
          onEmptied={refreshAfterBulkDelete}
          onUpload={() =>
            void navigate({
              to: '/buckets/$bucketName/upload',
              params: { bucketName },
              search: { region },
            })
          }
        />
      </div>

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
              listingError={listing.listingError}
              bucketName={bucketName}
              region={region}
              versions={page.versions}
              folders={page.folders}
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
              paging={listing.paging}
              search={folderSearch.text}
              onSearchChange={folderSearch.setText}
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
    </div>
  );
}
