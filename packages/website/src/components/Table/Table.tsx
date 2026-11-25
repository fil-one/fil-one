import { ArrowDownIcon, ArrowUpIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';

import { Checkbox } from '../Checkbox';

type TableProps = React.ComponentProps<'table'> & {
  containerStyle?: React.CSSProperties;
};

export function Table({ className, containerStyle, ...props }: TableProps) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto rounded-xl border border-zinc-200 bg-white"
      style={containerStyle}
      tabIndex={0}
    >
      <table data-slot="table" className={clsx('min-w-full', className)} {...props} />
    </div>
  );
}

Table.Header = TableHeader;
Table.Body = TableBody;
Table.Row = TableRow;
Table.Head = TableHead;
Table.Cell = TableCell;
Table.RowButton = TableRowButton;
Table.SelectHead = TableSelectHead;
Table.SelectCell = TableSelectCell;

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={clsx(className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={clsx(className)} {...props} />;
}

type TableRowProps = React.ComponentProps<'tr'> & {
  /**
   * Marks the row as selected or current, tinting it with
   * `--color-row-selected`. Owning this here keeps every table's selected state
   * identical instead of each one repeating the same background utility.
   *
   * The tint is applied after the base hover, so callers passing their own
   * background in `className` should only do so for the unselected case.
   */
  selected?: boolean;
  /**
   * Runs when a pointer clicks anywhere in the row outside its own controls.
   *
   * A mouse convenience only. The row takes no role and no tab stop: a row that
   * is a button hides its cells from table navigation, and the buttons inside it
   * become controls nested in a control, which screen readers cannot reach
   * reliably. The same action must also be a `Table.RowButton` in the row, which
   * is how a keyboard or screen reader gets to it.
   */
  onActivate?: () => void;
};

function TableRow({ selected, onActivate, className, onClick, ...props }: TableRowProps) {
  return (
    <tr
      data-slot="table-row"
      data-selected={selected ? '' : undefined}
      className={clsx(
        'border-b border-zinc-100 transition-colors last:border-0 hover:bg-zinc-50',
        onActivate && 'cursor-pointer',
        className,
        selected && 'bg-(--color-row-selected) hover:bg-(--color-row-selected)',
      )}
      onClick={(event) => {
        onClick?.(event);
        if (onActivate && isRowItself(event.currentTarget, event.target)) onActivate();
      }}
      {...props}
    />
  );
}

/**
 * Whether a click landed on the row itself rather than on one of its controls
 * (a checkbox, a button, a link), which does its own job and not the row's too.
 *
 * React passes events up through portals, so a click in a menu or dialog opened
 * from the row reaches the row as well; those are outside the row's elements.
 */
function isRowItself(row: Element, target: EventTarget): boolean {
  return (
    target instanceof Element &&
    row.contains(target) &&
    target.closest('button, a, input, label, [role="checkbox"]') === null
  );
}

/**
 * The row's main action as a real button, usually the name in the first cell.
 * Pair it with `onActivate` on the row so a click anywhere in the row does the
 * same; this button is what a keyboard reaches and a screen reader announces.
 *
 * It truncates with its text, so a long name never pushes the row's other
 * controls out of view.
 */
function TableRowButton({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      data-slot="table-row-button"
      className={clsx(
        'min-w-0 cursor-pointer truncate rounded-md text-left hover:underline focus-visible:brand-outline',
        className,
      )}
      {...props}
    />
  );
}

export type TableSortDirection = 'asc' | 'desc';

type TableHeadProps = React.ComponentProps<'th'> & {
  sticky?: boolean;
  /**
   * Makes the header a sort toggle. Pass `sortDirection` for the active column
   * and leave it undefined on the others.
   */
  onSort?: () => void;
  sortDirection?: TableSortDirection;
};

const ARIA_SORT: Record<TableSortDirection, 'ascending' | 'descending'> = {
  asc: 'ascending',
  desc: 'descending',
};

function TableHead({
  sticky,
  className,
  onSort,
  sortDirection,
  children,
  ...props
}: TableHeadProps) {
  return (
    <th
      data-slot="table-head"
      aria-sort={onSort ? (sortDirection ? ARIA_SORT[sortDirection] : 'none') : undefined}
      className={clsx(
        'border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs font-normal text-zinc-600 whitespace-nowrap',
        sticky && 'sticky top-0',
        className,
      )}
      {...props}
    >
      {onSort ? (
        <button
          type="button"
          onClick={onSort}
          className="group -mx-1 flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:text-zinc-900 focus-visible:brand-outline"
        >
          {children}
          <SortIcon direction={sortDirection} />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

/**
 * Inactive columns keep the icon mounted but nearly invisible, so hovering hints
 * that the header sorts without the row of labels shifting on hover.
 */
function SortIcon({ direction }: { direction?: TableSortDirection }) {
  const Icon = direction === 'desc' ? ArrowDownIcon : ArrowUpIcon;
  return (
    <Icon
      size={11}
      weight="bold"
      aria-hidden
      className={clsx(
        'transition-opacity',
        direction ? 'opacity-100' : 'opacity-0 group-hover:opacity-40',
      )}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={clsx('px-4 py-3 text-sm align-middle whitespace-nowrap', className)}
      {...props}
    />
  );
}

type SelectionProps = {
  checked: boolean;
  onChange: () => void;
  /** Accessible name, e.g. "Select all objects" or "Select report.pdf". */
  label: string;
  className?: string;
};

/**
 * Header cell holding a select-all checkbox. Zero width so the column takes only
 * what the checkbox needs, and no right padding because the checkbox's own hit
 * area already extends past its box.
 */
function TableSelectHead({ checked, onChange, label, className }: SelectionProps) {
  return (
    <TableHead className={clsx('w-0 pr-0', className)}>
      <Checkbox checked={checked} onChange={onChange} aria-label={label} />
    </TableHead>
  );
}

/**
 * Row cell holding a selection checkbox. Clicks stop here so ticking a row in a
 * table whose rows are themselves clickable does not also trigger the row.
 */
function TableSelectCell({ checked, onChange, label, className }: SelectionProps) {
  return (
    <TableCell className={clsx('w-0 pr-0', className)} onClick={(e) => e.stopPropagation()}>
      <Checkbox checked={checked} onChange={onChange} aria-label={label} />
    </TableCell>
  );
}
