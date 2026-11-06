import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { S3Region } from '@filone/shared';

import { RestoreFilesDialog, type RestoreTarget } from './RestoreFilesDialog';
import { useToast } from './Toast';
import { findColdVersions, trackColdStorage } from '../lib/cold-storage-prototype.js';
import { getBucketListing } from '../lib/object-listing.js';

/**
 * Cold storage prototype (FIL-1608): "Restore all files" from the Buckets
 * table. A row doesn't hold its bucket's files, so this loads the listing the
 * bucket page would, then opens the restore over every frozen file in it.
 */
export function useRestoreAll() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [target, setTarget] = useState<RestoreTarget | null>(null);

  async function open(bucketName: string, region: S3Region) {
    trackColdStorage('restore opened', { scope: 'bucket', from: 'buckets table' });
    try {
      const { versions } = await getBucketListing(queryClient, bucketName, region);
      const cold = findColdVersions(bucketName, region, versions);
      if (cold.length === 0) {
        toast.success(`Nothing in ${bucketName} is frozen yet`);
        return;
      }
      setTarget({
        bucketName,
        region,
        scopes: [{ id: 'bucket', label: 'All frozen files', versions: cold }],
      });
    } catch {
      toast.error(`Couldn’t load the files in ${bucketName}`);
    }
  }

  return {
    open: (bucketName: string, region: S3Region) => void open(bucketName, region),
    dialog: <RestoreFilesDialog target={target} onClose={() => setTarget(null)} />,
  };
}
