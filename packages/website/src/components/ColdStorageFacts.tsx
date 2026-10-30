import type { IconProps } from './Icon';
import { formatUsd } from '../lib/cold-storage-prototype.js';

type RateCell = { label: string; pricePerTbMonth: number };

/**
 * Two per-TB rates side by side: the freeze review's standard rate against
 * the frozen one. Rates only, never the bucket's total, so the console states
 * what changes without adding up a bill.
 */
export function RateComparison({ cells }: { cells: [RateCell, RateCell] }) {
  return (
    <dl className="grid grid-cols-2 divide-x divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200">
      {cells.map((cell) => (
        <div key={cell.label} className="flex flex-col gap-1 px-4 py-3">
          <dt className="text-xs text-zinc-500">{cell.label}</dt>
          <dd className="flex items-baseline gap-1 tabular-nums">
            <span className="text-xl font-medium text-zinc-900">
              {formatUsd(cell.pricePerTbMonth)}
            </span>
            <span className="text-ui text-zinc-500">/TB-month</span>
          </dd>
        </div>
      ))}
    </dl>
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

/** The rate a choice bills at, as shown in the Rate column. */
export type RowRate = {
  /** "$5.99/TB-month". */
  rate: string;
  /** What qualifies the rate: its minimum, or the rate it replaces. */
  rateNote: string;
};

// A fixed width, so each rate lines up under the heading across rows. Below
// `sm` the column gives way to a labelled line under the row's text, since a
// rate column left the descriptions a few words wide.
const RATE_WIDTH = 'w-28 shrink-0 text-right';

/**
 * The Rate heading, set above the bordered list rather than in a header strip
 * of its own: one word doesn't need a filled row and a divider.
 */
export function RateColumnHeader() {
  return (
    <div
      className="hidden items-center gap-3 px-4 pb-1.5 text-xs text-zinc-500 sm:flex"
      aria-hidden="true"
    >
      <span className="flex-1" />
      <span className={RATE_WIDTH}>Rate</span>
    </div>
  );
}

/** A row's title and description, with its rate as a line beneath on small screens. */
export function RateRowText({
  title,
  description,
  rate,
}: {
  title: string;
  description: string;
  rate: RowRate;
}) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium text-zinc-900">{title}</span>
      <span className="text-xs text-zinc-500">{description}</span>
      <span className="mt-1 text-xs text-zinc-500 tabular-nums sm:hidden">
        <span className="font-medium text-zinc-900">{rate.rate}</span>, {rate.rateNote}
      </span>
    </span>
  );
}

/** A row's Rate cell, from `sm` up. */
export function RateRowAmount({ rate }: { rate: RowRate }) {
  return (
    <span className={`${RATE_WIDTH} hidden flex-col items-end tabular-nums sm:flex`}>
      <span className="font-medium text-zinc-900">{rate.rate}</span>
      <span className="text-xs text-zinc-500">{rate.rateNote}</span>
    </span>
  );
}
