import { clsx } from 'clsx';

type TableProps = React.ComponentProps<'table'> & {
  containerStyle?: React.CSSProperties;
};

export function Table({ className, containerStyle, ...props }: TableProps) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto rounded-lg border border-zinc-200 bg-white"
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
