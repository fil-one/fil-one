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
  /** Further actions on the selection, set before Delete. */
  extraActions?: React.ReactNode;
};

/**
 * Toolbar shown above a table while rows are selected: how many and a way out
 * on the left, the bulk actions on the right.
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
  extraActions,
}: BulkActionsBarProps) {
  return (
    <div className="mb-3 flex flex-col gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      {/* The count and the way out of it sit together; the actions on the
          selection sit apart, on the right, ending with the destructive one. */}
      {/* Baseline, not centre: the count is 13px and Clear's label 12px, so
          centring the two boxes left their text sitting at different heights. */}
      <div className="flex items-baseline gap-3">
        <span className="pl-1 text-ui font-medium text-zinc-900 tabular-nums">
          {count} selected
        </span>
        <Button variant="tertiary" size="sm" onClick={onClear}>
          Clear
        </Button>
      </div>
      <div className="flex items-center gap-2">
        {extraActions}
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
