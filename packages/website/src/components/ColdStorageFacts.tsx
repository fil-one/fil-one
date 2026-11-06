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

/**
 * What a cold storage action does, as label and value pairs, followed in the
 * dialog by any footnote. The markup is ToggleConfirmModal's fact list, so a
 * confirmation reads the same across the console.
 */
export function FactList({ facts }: { facts: { label: string; value: string }[] }) {
  return (
    <dl className="divide-y divide-(--color-border-muted) border-y border-(--color-border-muted)">
      {facts.map((fact) => (
        <div key={fact.label} className="flex gap-4 py-2.5 text-sm leading-relaxed">
          <dt className="w-28 flex-shrink-0 text-(--color-paragraph-text-subtle)">{fact.label}</dt>
          <dd className="text-(--color-paragraph-text-strong)">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
