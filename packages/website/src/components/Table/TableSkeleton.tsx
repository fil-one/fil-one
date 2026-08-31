import { cn } from '../../lib/utils.js';
import { Skeleton } from '../Skeleton.js';
import { Table } from './Table.js';

// A few natural bar widths, cycled per column so a loading row doesn't read as a
// grid of identical blocks.
const CELL_WIDTHS = ['w-28', 'w-20', 'w-24', 'w-16'] as const;

export type SkeletonColumn = {
  /**
   * The real header label. A column header never changes while its data loads,
   * so it is shown as-is rather than as a placeholder bar. Omit for an actions
   * column, which has no visible heading.
   */
  label?: string;
  /**
   * Visibility/responsive class shared by the header cell and its body cells, so
   * the placeholder drops the same columns at the same breakpoints as the real
   * table it stands in for (e.g. `hidden sm:table-cell`).
   */
  className?: string;
};

type TableSkeletonProps = {
  /** The columns to mirror, matching the real table (labels and breakpoints). */
  columns: SkeletonColumn[];
  /** Placeholder rows to show. Five is a calm mid-list height. */
  rows?: number;
  /** Announced to assistive tech, e.g. "Loading buckets". */
  'aria-label'?: string;
};

/**
 * A table-shaped loading placeholder: the same bordered container, header band
 * and row rhythm as `Table`. The header shows real labels (they are known before
 * any data arrives), and only the body cells pulse. Rendered inside the page
 * shell, not in front of it, so navigating to a list never blanks the header or
 * its actions.
 */
export function TableSkeleton({
  columns,
  rows = 5,
  'aria-label': ariaLabel = 'Loading',
}: TableSkeletonProps) {
  const cols = columns.map((col, i) => ({
    ...col,
    key: col.label || `actions-${i}`,
    width: col.label ? CELL_WIDTHS[i % CELL_WIDTHS.length] : 'w-4',
  }));
  const rowKeys = Array.from({ length: rows }, (_, i) => `row-${i}`);

  return (
    <div role="status" aria-label={ariaLabel}>
      <Table>
        <Table.Header>
          <Table.Row>
            {cols.map((col) => (
              <Table.Head key={col.key} className={col.className}>
                {col.label ?? <span className="sr-only">Actions</span>}
              </Table.Head>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rowKeys.map((rowKey) => (
            <Table.Row key={rowKey}>
              {cols.map((col) => (
                <Table.Cell key={col.key} className={col.className}>
                  <Skeleton className={cn('h-4', col.width)} />
                </Table.Cell>
              ))}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}
