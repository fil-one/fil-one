import { useState } from 'react';

import type { DeleteFoldersDialogProps } from './DeleteFoldersDialog';
import { folderSelectionId } from '../lib/object-selection.js';
import type { ObjectSelection, SelectionTargets } from '../lib/object-selection.js';
import type { ObjectDeleteTarget } from '../lib/use-object-actions.js';
import type { FolderDeleteJobs } from '../lib/use-folder-delete-jobs.js';

export type UseFolderDeleteOptions = {
  /** The page's folder deletions, which outlive this browser. */
  jobs: FolderDeleteJobs;
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
  jobs,
  selection,
  onBulkDelete,
  onFoldersDeleted,
}: UseFolderDeleteOptions) {
  // The request outlives `open` so the dialog keeps its folders while it fades out.
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<SelectionTargets>({ folderPrefixes: [], objects: [] });
  const [deletingObjects, setDeletingObjects] = useState(false);

  async function confirm() {
    setDeletingObjects(true);
    try {
      const [{ started, unstartedPrefixes }] = await Promise.all([
        jobs.start(request.folderPrefixes),
        request.objects.length > 0 ? onBulkDelete?.(request.objects) : undefined,
      ]);
      // Folders whose deletion did not start stay selected, ready to try again.
      if (started.length > 0) {
        selection.clear();
        selection.setMany(unstartedPrefixes.map(folderSelectionId), true);
      }
    } finally {
      setDeletingObjects(false);
    }
  }

  // The page watches the jobs after the dialog closes, so the listing
  // refreshes again when they finish; they reset when the next deletion opens
  // the dialog.
  function close() {
    // Whatever the jobs have deleted is gone, so the listing should say so.
    // Also once they finish: the listing read when they did can still hold a
    // folder the deletion emptied.
    if (jobs.jobs.length > 0) onFoldersDeleted?.();
    setOpen(false);
  }

  const dialogProps: DeleteFoldersDialogProps = {
    open,
    onClose: close,
    folderPrefixes: request.folderPrefixes,
    objectCount: request.objects.length,
    onConfirm: () => void confirm(),
    jobs: jobs.jobs,
    unstartedPrefixes: jobs.unstartedPrefixes,
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
