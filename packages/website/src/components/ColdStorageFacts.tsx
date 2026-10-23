import clsx from 'clsx';

import type { IconProps } from './Icon';
import { formatUsd } from '../lib/cold-storage-prototype.js';

type PriceCell = { label: string; amount: number; unit: string };

/**
 * Two prices side by side with a line under them, shared by the Learn more
 * dialog (standard against cold) and the freeze review (this bucket today
 * against frozen), so both read as the same comparison.
 */
export function PriceComparison({
  cells,
  footer,
}: {
  cells: [PriceCell, PriceCell];
  footer: { label: string; value: string; positive?: boolean };
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200">
      <dl className="grid grid-cols-2 divide-x divide-zinc-200">
        {cells.map((cell) => (
          <div key={cell.label} className="flex flex-col gap-1 px-4 py-3">
            <dt className="text-xs text-zinc-500">{cell.label}</dt>
            <dd className="flex items-baseline gap-1 tabular-nums">
              <span className="text-xl font-medium text-zinc-900">{formatUsd(cell.amount)}</span>
              <span className="text-ui text-zinc-500">{cell.unit}</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="flex items-center justify-between gap-3 border-t border-zinc-200 bg-zinc-50 px-4 py-2 text-ui">
        <span className="text-zinc-600">{footer.label}</span>
        <span
          className={clsx(
            'font-medium tabular-nums',
            footer.positive ? 'text-green-700' : 'text-zinc-900',
          )}
        >
          {footer.value}
        </span>
      </p>
    </div>
  );
}

export function TermList({ children }: { children: React.ReactNode }) {
  return <ul className="flex flex-col gap-3">{children}</ul>;
}

/** One rule of cold storage: the rule in a line, then what it means. */
export function Term({
  icon: Icon,
  title,
  children,
}: {
  icon: IconProps['component'];
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <Icon size={16} className="mt-0.5 shrink-0 text-zinc-400" aria-hidden="true" />
      <div className="flex flex-col gap-0.5">
        <span className="text-ui font-medium text-zinc-900">{title}</span>
        <span className="text-ui text-zinc-500">{children}</span>
      </div>
    </li>
  );
}
