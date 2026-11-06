import { useNavigate } from '@tanstack/react-router';
import { CloudArrowUpIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';

import type { BucketAnalyticsResponse, BucketDetails, S3Region } from '@filone/shared';

import { BucketActionMenu, type BucketAction } from '../components/BucketActionMenu';
import { BucketDetailsButton } from '../components/BucketDetailsDrawer';
import { Button } from '../components/Button';
import { useEmptyBucketAction } from '../components/EmptyBucketAction';
import { Heading } from '../components/Heading/Heading';

/**
 * The action bar beside the bucket heading: Upload as the one button, and the
 * rare actions in a "…" menu, Freeze files and Restore files (cold storage
 * prototype) and Empty bucket, so the destructive one is a deliberate step
 * away. Each goes with its permission: emptying is a bulk `objects.delete`,
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
  return (
    <div className="mt-4 mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <Heading id="bucket-detail-heading" tag="h1" size="xl">
          {bucketName}
        </Heading>
        <BucketDetailsButton
          bucket={bucket}
          region={region}
          bytesUsed={analytics?.bytesUsed}
          objectCount={analytics?.objectCount}
        />
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
        coldMenuActions={coldMenuActions}
      />
    </div>
  );
}
