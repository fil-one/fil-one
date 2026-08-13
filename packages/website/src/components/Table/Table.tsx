import { ArrowDownIcon, ArrowUpIcon } from '@phosphor-icons/react/dist/ssr';
import { clsx } from 'clsx';

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

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={clsx(className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={clsx(className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={clsx(
        'border-b border-zinc-100 transition-colors last:border-0 hover:bg-zinc-50',
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
          className="group -mx-1 flex items-center gap-1 rounded-sm px-1 py-0.5 transition-colors hover:text-zinc-900 focus-visible:brand-outline"
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
