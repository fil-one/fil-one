import { TrashIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from './Button';

export type BulkActionsBarProps = {
  /** Number of selected rows. The bar is the caller's to hide when this is 0. */
  count: number;
  onClear: () => void;
  onDelete: () => void;
  /**
   * Id for the delete button, so tests and analytics can tell one table's bar
   * from another's when a page shows more than one.
   */
  deleteButtonId?: string;
  /** Overrides the delete label, e.g. "Revoke" where deleting is not the word. */
  deleteLabel?: string;
};

/**
 * Toolbar shown above a table while rows are selected: how many, a way out, and
 * the bulk action.
 *
 * Shared rather than per-table so selection feels identical wherever it appears.
 * Stacks below the count on narrow screens so the buttons keep their full size
 * instead of being squeezed.
 */
export function BulkActionsBar({
  count,
  onClear,
  onDelete,
  deleteButtonId,
  deleteLabel = 'Delete',
}: BulkActionsBarProps) {
  return (
    <div className="mb-3 flex flex-col gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-zinc-600">{count} selected</span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
        <Button
          {...(deleteButtonId && { id: deleteButtonId })}
          variant="destructive"
          size="sm"
          icon={TrashIcon}
          onClick={onDelete}
        >
          {deleteLabel}
        </Button>
      </div>
    </div>
  );
}
