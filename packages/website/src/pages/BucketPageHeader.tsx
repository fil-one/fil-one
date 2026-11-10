import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CloudArrowUpIcon, InfoIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';

import type { BucketAnalyticsResponse, BucketDetails, S3Region } from '@filone/shared';

import { BucketActionMenu, type BucketAction } from '../components/BucketActionMenu';
import { BucketDetailsDrawer } from '../components/BucketDetailsDrawer';
import { ColdStorageBadge } from '../components/ColdStorageStatus';
import { useBucketColdSummary } from '../lib/cold-storage-prototype.js';
import { Button } from '../components/Button';
import { useEmptyBucketAction } from '../components/EmptyBucketAction';
import { Heading } from '../components/Heading/Heading';

/**
 * The action bar beside the bucket heading: Upload as the one button, and the
 * rare actions in a "…" menu: Bucket details, Freeze files and Restore files
 * (cold storage prototype), and Empty bucket last, so the destructive one is a
 * deliberate step away. Each goes with its permission: emptying is a bulk `objects.delete`,
 * uploading is `objects.write`. An empty bucket has nothing to empty and
 * carries its upload in the empty state, so it shows neither.
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
  onOpenDetails,
  coldMenuActions,
}: {
  bucketName: string;
  region: S3Region;
  hasObjects: boolean;
  mayDelete: boolean;
  mayUpload: boolean;
  totalObjectCount: number | undefined;
  onEmptied: () => void;
  onUpload: () => void;
  /** Opens the bucket details panel; absent until the bucket has loaded. */
  onOpenDetails?: () => void;
  /** Cold storage prototype: Freeze files and Restore files, when they apply. */
  coldMenuActions: BucketAction[];
}) {
  const emptyBucket = useEmptyBucketAction({
    bucketName,
    region,
    totalObjectCount,
    onFinished: onEmptied,
  });
  const menuActions: BucketAction[] = [
    ...(onOpenDetails
      ? [{ label: 'Bucket details', icon: InfoIcon, onSelect: onOpenDetails }]
      : []),
    ...coldMenuActions,
    ...(hasObjects && mayDelete
      ? [{ label: 'Empty bucket', icon: TrashIcon, onSelect: emptyBucket.open }]
      : []),
  ];
  return (
    <div className="flex items-center gap-2">
      {hasObjects && mayUpload && (
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
      {menuActions.length > 0 && <BucketActionMenu actions={menuActions} />}
      {emptyBucket.dialog}
    </div>
  );
}

/** The bucket's name with the info button that opens Bucket details, and its actions. */
export function BucketPageHeader({
  bucketName,
  bucket,
  region,
  analytics,
  hasObjects,
  mayDelete,
  mayUpload,
  onEmptied,
  coldMenuActions,
}: {
  bucketName: string;
  bucket: BucketDetails | null;
  region: S3Region;
  analytics: BucketAnalyticsResponse | undefined;
  hasObjects: boolean;
  mayDelete: boolean;
  mayUpload: boolean;
  onEmptied: () => void;
  /** Cold storage prototype: Freeze files and Restore files, when they apply. */
  coldMenuActions: BucketAction[];
}) {
  const navigate = useNavigate();
  const coldSummary = useBucketColdSummary(bucketName, region);
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <div className="mt-4 mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <Heading id="bucket-detail-heading" tag="h1" size="xl">
          {bucketName}
        </Heading>
        {/* Cold storage prototype: the Buckets table's pill, so a bucket frozen
            as a whole says so on its own page, new uploads included. */}
        {coldSummary && <ColdStorageBadge summary={coldSummary} />}
      </div>
      <BucketHeaderActions
        bucketName={bucketName}
        region={region}
        hasObjects={hasObjects}
        mayDelete={mayDelete}
        mayUpload={mayUpload}
        totalObjectCount={analytics?.objectCount}
        onEmptied={onEmptied}
        onUpload={() =>
          void navigate({
            to: '/buckets/$bucketName/upload',
            params: { bucketName },
            search: { region },
          })
        }
        onOpenDetails={bucket ? () => setDetailsOpen(true) : undefined}
        coldMenuActions={coldMenuActions}
      />
      {bucket && detailsOpen && (
        <BucketDetailsDrawer
          bucket={bucket}
          region={region}
          bytesUsed={analytics?.bytesUsed}
          objectCount={analytics?.objectCount}
          onClose={() => setDetailsOpen(false)}
        />
      )}
    </div>
  );
}
