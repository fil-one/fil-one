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
};

function TableRow({ selected, className, ...props }: TableRowProps) {
  return (
    <tr
      data-slot="table-row"
      data-selected={selected ? '' : undefined}
      className={clsx(
        'border-b border-zinc-100 transition-colors last:border-0 hover:bg-zinc-50',
        className,
        selected && 'bg-(--color-row-selected) hover:bg-(--color-row-selected)',
      )}
      {...props}
    />
  );
}

type TableHeadProps = React.ComponentProps<'th'> & {
  sticky?: boolean;
};

function TableHead({ sticky, className, ...props }: TableHeadProps) {
  return (
    <th
      data-slot="table-head"
      className={clsx(
        'border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs font-normal text-zinc-600 whitespace-nowrap',
        sticky && 'sticky top-0',
        className,
      )}
      {...props}
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
