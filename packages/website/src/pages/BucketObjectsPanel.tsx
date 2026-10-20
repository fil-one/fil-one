import type { S3ObjectVersion, S3Region } from '@filone/shared';

import { ObjectBrowser, type EmptyBucketKeyAction } from '../components/ObjectBrowser';
import { TableSkeleton, type SkeletonColumn } from '../components/Table/TableSkeleton';
import type { useObjectActions } from '../lib/use-object-actions.js';

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
 * The key step an empty bucket offers: the keys that reach it already, when there are
 * any, else a new one.
 */
function getEmptyBucketKeyAction({
  accessKeyCount,
  mayCreateKeys,
  onAddKeyOpenChange,
  onShowKeys,
}: {
  accessKeyCount: number;
  mayCreateKeys: boolean;
  onAddKeyOpenChange: (open: boolean) => void;
  onShowKeys: () => void;
}): EmptyBucketKeyAction | undefined {
  // Keys exist only for a caller who may list them, which is also what shows the Keys tab
  if (accessKeyCount > 0) return { kind: 'view', onView: onShowKeys };
  if (mayCreateKeys) return { kind: 'create', onCreate: () => onAddKeyOpenChange(true) };
  return undefined;
}

/**
 * The Objects tab's body: the listing, or a table-shaped placeholder while it
 * loads. Extracted so the page component stays about layout, and so the
 * loading branch sits next to the table it stands in for.
 */
export function ObjectsPanel({
  loading,
  objectActions,
  mayUpload,
  mayDelete,
  accessKeyCount,
  accessKeysLoading,
  mayCreateKeys,
  onAddKeyOpenChange,
  onShowKeys,
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
  accessKeyCount: number;
  accessKeysLoading: boolean;
  mayCreateKeys: boolean;
  onAddKeyOpenChange: (open: boolean) => void;
  onShowKeys: () => void;
  listingTruncated: boolean;
  totalObjectCount: number | undefined;
}) {
  // An empty bucket's next steps depend on its keys, so its empty state waits for the key
  // list too and appears once, in its final form; a bucket with objects does not wait.
  if (loading || (browser.versions.length === 0 && accessKeysLoading)) {
    return <TableSkeleton columns={OBJECT_SKELETON_COLUMNS} aria-label="Loading objects" />;
  }

  return (
    <ObjectBrowser
      {...browser}
      onDownload={objectActions.downloadObject}
      downloading={objectActions.downloading}
      canUpload={mayUpload}
      keyAction={getEmptyBucketKeyAction({
        accessKeyCount,
        mayCreateKeys,
        onAddKeyOpenChange,
        onShowKeys,
      })}
      onDelete={mayDelete ? objectActions.deleteObject : undefined}
      onBulkDelete={mayDelete ? objectActions.deleteObjects : undefined}
    />
  );
}
