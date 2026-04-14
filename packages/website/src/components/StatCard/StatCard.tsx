import { cn } from '../../lib/utils.js';
import { ProgressBar } from '../ProgressBar.js';

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
    <div className={cn('relative rounded-xl border border-zinc-200 bg-white p-5', className)}>
      <div className={cn('flex items-start justify-between gap-2', isLarge ? 'mb-4' : 'mb-2.5')}>
        <span className={cn('text-xs font-medium uppercase tracking-wider text-zinc-500')}>
          {label}
        </span>
        {usage && <span className="shrink-0 text-xs text-zinc-500">{usage}</span>}
      </div>

      <div className={cn('flex items-baseline', isLarge ? 'gap-1.5' : 'gap-1')}>
        <span
          className={cn(
            'font-semibold text-zinc-950',
            isLarge ? 'text-3xl tracking-tight' : 'text-xl',
          )}
        >
          {value}
        </span>
        {limit && (
          <span className={cn('text-zinc-500', isLarge ? 'text-sm' : 'text-xs')}>{limit}</span>
        )}
      </div>

      {progress !== undefined && (
        <ProgressBar value={progress} size="sm" className="mt-4" label={`${label} usage`} />
      )}
    </div>
  );
}
