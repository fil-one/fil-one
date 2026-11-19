import type { S3ObjectVersion, S3Region } from '@filone/shared';

import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { ListingPager } from '../components/ListingPager';
import {
  ObjectBrowser,
  type EmptyBucketKeyAction,
  type ObjectBrowserProps,
} from '../components/ObjectBrowser';
import { TableSkeleton, type SkeletonColumn } from '../components/Table/TableSkeleton';
import type { useObjectActions } from '../lib/use-object-actions.js';

// Mirrors ObjectBrowser's columns so the placeholder holds the same shape as the
// table it stands in for.
const OBJECT_SKELETON_COLUMNS: SkeletonColumn[] = [
  { label: 'Name' },
  { label: 'Size' },
  { label: 'Last modified' },
  {},
];

/**
 * The key step an empty bucket offers: the keys that reach it already, when there are
 * any, else a new one.
 */
function getEmptyBucketKeyAction({
  activeAccessKeyCount,
  accessKeysFailed,
  mayCreateKeys,
  onAddKeyOpenChange,
  onShowKeys,
}: {
  activeAccessKeyCount: number;
  accessKeysFailed: boolean;
  mayCreateKeys: boolean;
  onAddKeyOpenChange: (open: boolean) => void;
  onShowKeys: () => void;
}): EmptyBucketKeyAction | undefined {
  // A list that failed to load says nothing about whether keys exist, and offering a new key
  // then could mint a duplicate; the Keys tab shows the failure.
  if (accessKeysFailed) return undefined;
  // Keys exist only for a caller who may list them, which is also what shows the Keys tab.
  // An expired key no longer opens the bucket, so a bucket with only expired keys is offered a new one.
  if (activeAccessKeyCount > 0) return { kind: 'view', onView: onShowKeys };
  if (mayCreateKeys) return { kind: 'create', onCreate: () => onAddKeyOpenChange(true) };
  return undefined;
}

/**
 * A page past the first that failed to load. The pager stays, so the reader can
 * go back to a page that did load instead of being stranded on this one.
 */
function PageErrorState({
  message,
  onRetry,
  paging,
}: {
  message: string;
  onRetry: () => void;
  paging: ObjectBrowserProps['paging'];
}) {
  return (
    <div className="mt-4">
      <Alert
        variant="red"
        title="This page did not load"
        description={message}
        action={
          <Button variant="tertiary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      />
      {paging && <ListingPager {...paging} label="Object pages" />}
    </div>
  );
}

/**
 * The Objects tab's body: the listing, or a table-shaped placeholder while it
 * loads. Extracted so the page component stays about layout, and so the
 * loading branch sits next to the table it stands in for.
 */
export function ObjectsPanel({
  loading,
  listingError,
  objectActions,
  mayUpload,
  mayDelete,
  activeAccessKeyCount,
  accessKeysLoading,
  accessKeysFailed,
  permissionsLoading,
  mayCreateKeys,
  onAddKeyOpenChange,
  onShowKeys,
  ...browser
}: {
  loading: boolean;
  listingError?: { message: string; onRetry: () => void };
  bucketName: string;
  region: S3Region;
  versions: S3ObjectVersion[];
  folders: string[];
  versioningEnabled: boolean;
  currentPrefix: string;
  onPrefixChange: (prefix: string) => void;
  objectActions: ReturnType<typeof useObjectActions>;
  mayUpload: boolean;
  mayDelete: boolean;
  activeAccessKeyCount: number;
  accessKeysLoading: boolean;
  accessKeysFailed: boolean;
  permissionsLoading: boolean;
  mayCreateKeys: boolean;
  onAddKeyOpenChange: (open: boolean) => void;
  onShowKeys: () => void;
  paging: ObjectBrowserProps['paging'];
  search: string;
  onSearchChange: (search: string) => void;
  onFoldersDeleted: () => void;
}) {
  // An empty bucket's next steps depend on its keys and the caller's permissions, so its
  // empty state waits for both and appears once, in its final form; a bucket with objects
  // does not wait.
  if (listingError) {
    return <PageErrorState {...listingError} paging={browser.paging} />;
  }

  const isEmptyStateUnsettled = accessKeysLoading || permissionsLoading;
  const looksEmpty =
    browser.versions.length === 0 && browser.folders.length === 0 && browser.search === '';
  if (loading || (looksEmpty && isEmptyStateUnsettled)) {
    return <TableSkeleton columns={OBJECT_SKELETON_COLUMNS} aria-label="Loading objects" />;
  }

  return (
    <ObjectBrowser
      {...browser}
      onDownload={objectActions.downloadObject}
      downloading={objectActions.downloading}
      canUpload={mayUpload}
      keyAction={getEmptyBucketKeyAction({
        activeAccessKeyCount,
        accessKeysFailed,
        mayCreateKeys,
        onAddKeyOpenChange,
        onShowKeys,
      })}
      onDelete={mayDelete ? objectActions.deleteObject : undefined}
      onBulkDelete={mayDelete ? objectActions.deleteObjects : undefined}
    />
  );
}
