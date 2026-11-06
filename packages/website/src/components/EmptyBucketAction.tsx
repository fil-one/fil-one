import { useState } from 'react';

import type { BulkDeleteJob, S3Region } from '@filone/shared';

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
 * The "empty bucket" confirmation and its job state, for a caller that places
 * its own trigger, such as a menu item. The dialog renders in a portal, so its
 * position in the tree does not matter.
 */
export function useEmptyBucketAction({
  bucketName,
  region,
  totalObjectCount,
  onFinished,
}: EmptyBucketActionProps) {
  const [open, setOpen] = useState(false);
  const bulkDelete = useBulkDeleteJob({ bucketName, region, onFinished });
  return {
    open: () => setOpen(true),
    dialog: (
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
    ),
  };
}
