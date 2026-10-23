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

/** What a choice costs now and each month from then on, as shown in the Now and Monthly columns. */
export type RowCosts = {
  now: string;
  monthly: string;
  /** How the monthly amount compares with today's: "no change", or what it was. */
  monthlyNote: string;
};

// Fixed widths, so each amount lines up under its heading across rows. Below
// `sm` the columns give way to a labelled line under the row's text, since two
// number columns left the descriptions a few words wide.
const NOW_WIDTH = 'w-16 shrink-0 text-right';
const MONTHLY_WIDTH = 'w-20 shrink-0 text-right';

/**
 * The Now and Monthly headings, set above the bordered list rather than in a
 * header strip of their own: two words don't need a filled row and a divider.
 */
export function CostColumnsHeader() {
  return (
    <div
      className="hidden items-center gap-3 px-4 pb-1.5 text-xs text-zinc-500 sm:flex"
      aria-hidden="true"
    >
      <span className="flex-1" />
      <span className={NOW_WIDTH}>Now</span>
      <span className={MONTHLY_WIDTH}>Monthly</span>
    </div>
  );
}

/** A row's title and description, with its costs as a line beneath on small screens. */
export function CostRowText({
  title,
  description,
  costs,
}: {
  title: string;
  description: string;
  costs: RowCosts;
}) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium text-zinc-900">{title}</span>
      <span className="text-xs text-zinc-500">{description}</span>
      <span className="mt-1 flex flex-wrap gap-x-3 text-xs text-zinc-500 tabular-nums sm:hidden">
        <span>
          Now <span className="font-medium text-zinc-900">{costs.now}</span>
        </span>
        <span>
          Monthly <span className="font-medium text-zinc-900">{costs.monthly}</span>,{' '}
          {costs.monthlyNote}
        </span>
      </span>
    </span>
  );
}

/** A row's Now and Monthly cells, from `sm` up. */
export function CostRowAmounts({ costs }: { costs: RowCosts }) {
  return (
    <>
      <span className={`${NOW_WIDTH} hidden font-medium text-zinc-900 tabular-nums sm:block`}>
        {costs.now}
      </span>
      <span className={`${MONTHLY_WIDTH} hidden flex-col items-end tabular-nums sm:flex`}>
        <span className="font-medium text-zinc-900">{costs.monthly}</span>
        <span className="text-xs text-zinc-500">{costs.monthlyNote}</span>
      </span>
    </>
  );
}
