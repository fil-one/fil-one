import { clsx } from 'clsx';
import { ProgressBar } from './ProgressBar';

export type StatCardProps = {
  label: string;
  value: string;
  limit?: string;
  usage?: string;
  /** 0-100. When provided, renders a ProgressBar below the value. */
  progress?: number;
  /** "lg" for prominent cards (Storage/Downloads), default for compact cards */
  size?: 'lg';
  className?: string;
};

export function StatCard({ label, value, limit, usage, progress, size, className }: StatCardProps) {
  const isLarge = size === 'lg';

  return (
    <div
      className={clsx(
        'relative rounded-xl border border-zinc-200 bg-white',
        isLarge ? 'p-6' : 'px-[17px] pb-[17px] pt-[22px]',
        className,
      )}
    >
      <div className={clsx('flex items-start justify-between gap-2', isLarge ? 'mb-4' : 'mb-2.5')}>
        <span
          className={clsx(
            'font-medium uppercase tracking-wider text-zinc-500',
            isLarge ? 'text-xs' : 'text-[11px]',
          )}
        >
          {label}
        </span>
        {usage && <span className="shrink-0 text-[11px] text-zinc-500">{usage}</span>}
      </div>

      <div className={clsx('flex items-baseline', isLarge ? 'gap-1.5' : 'gap-1')}>
        <span
          className={clsx(
            'font-semibold text-zinc-950',
            isLarge ? 'text-[30px] leading-9 tracking-tight' : 'text-xl',
          )}
        >
          {value}
        </span>
        {limit && (
          <span className={clsx('text-zinc-500', isLarge ? 'text-[13px]' : 'text-[11px]')}>
            {limit}
          </span>
        )}
      </div>

      {progress !== undefined && (
        <ProgressBar value={progress} size="sm" className="mt-4" label={`${label} usage`} />
      )}
    </div>
  );
}
