import { useState } from 'react';
import { TrashIcon } from '@phosphor-icons/react/dist/ssr';

import type { BulkDeleteJob, S3Region } from '@filone/shared';

import { Button } from './Button';
import { EmptyBucketDialog } from './EmptyBucketDialog';
import { useBulkDeleteJob } from '../lib/use-bulk-delete-job.js';

export type EmptyBucketActionProps = {
  bucketName: string;
  region: S3Region;
  /** From analytics, so it covers the whole bucket rather than one listing page. */
  totalObjectCount?: number;
  onFinished?: (job: BulkDeleteJob) => void;
};

/**
 * The "empty bucket" entry point: button plus its confirmation dialog. Both live
 * here so the job state stays in one place; the dialog renders in a portal, so
 * its position in the tree does not matter.
 */
export function EmptyBucketAction({
  bucketName,
  region,
  totalObjectCount,
  onFinished,
}: EmptyBucketActionProps) {
  const [open, setOpen] = useState(false);
  const bulkDelete = useBulkDeleteJob({ bucketName, region, onFinished });

  return (
    <>
      <Button
        id="empty-bucket-button"
        variant="ghost"
        size="sm"
        icon={TrashIcon}
        onClick={() => setOpen(true)}
      >
        Empty bucket
      </Button>

      <EmptyBucketDialog
        open={open}
        onClose={() => {
          setOpen(false);
          bulkDelete.reset();
        }}
        bucketName={bucketName}
        totalObjectCount={totalObjectCount}
        onConfirm={() => void bulkDelete.start()}
        job={bulkDelete.job}
        starting={bulkDelete.starting}
        isRunning={bulkDelete.isRunning}
      />
    </>
  );
}
