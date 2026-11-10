import { useState } from 'react';

import type { S3Region } from '@filone/shared';

import type { DeleteFoldersDialogProps } from './DeleteFoldersDialog';
import type { ObjectSelection, SelectionTargets } from '../lib/object-selection.js';
import type { ObjectDeleteTarget } from '../lib/use-object-actions.js';
import { useFolderDeleteJobs } from '../lib/use-folder-delete-jobs.js';

export type UseFolderDeleteOptions = {
  bucketName: string;
  region: S3Region;
  selection: ObjectSelection;
  /** Deletes the objects selected alongside the folders. */
  onBulkDelete?: (targets: ObjectDeleteTarget[]) => Promise<void>;
  onFoldersDeleted?: () => void;
};

/**
 * The object browser's delete of a selection holding folders: what the dialog
 * shows, and the jobs it starts. The selection is read when the dialog opens,
 * so the dialog keeps naming the same folders once the selection clears.
 */
export function useFolderDelete({
  bucketName,
  region,
  selection,
  onBulkDelete,
  onFoldersDeleted,
}: UseFolderDeleteOptions) {
  // The request outlives `open` so the dialog keeps its folders while it fades out.
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<SelectionTargets>({ folderPrefixes: [], objects: [] });
  const [deletingObjects, setDeletingObjects] = useState(false);
  const jobs = useFolderDeleteJobs({ bucketName, region, onFinished: () => onFoldersDeleted?.() });

  async function confirm() {
    setDeletingObjects(true);
    try {
      const [started] = await Promise.all([
        jobs.start(request.folderPrefixes),
        request.objects.length > 0 ? onBulkDelete?.(request.objects) : undefined,
      ]);
      if (started.length > 0) selection.clear();
    } finally {
      setDeletingObjects(false);
    }
  }

  // The jobs stay watched after the dialog closes, so the listing refreshes
  // again when they finish; they reset when the next deletion opens the dialog.
  function close() {
    // Whatever the job has deleted so far is gone, so the listing should say so.
    if (jobs.isRunning) onFoldersDeleted?.();
    setOpen(false);
  }

  const dialogProps: DeleteFoldersDialogProps = {
    open,
    onClose: close,
    folderPrefixes: request.folderPrefixes,
    objectCount: request.objects.length,
    onConfirm: () => void confirm(),
    jobs: jobs.jobs,
    starting: jobs.starting || deletingObjects,
    isRunning: jobs.isRunning,
  };

  return {
    /**
     * Opens the dialog when the selection holds a folder. Returns whether it
     * did, so a selection of objects alone can take the plain confirmation.
     */
    request: (): boolean => {
      const targets = selection.targets();
      if (targets.folderPrefixes.length === 0) return false;
      jobs.reset();
      setRequest(targets);
      setOpen(true);
      return true;
    },
    dialogProps,
  };
}
