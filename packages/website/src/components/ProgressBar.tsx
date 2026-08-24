import { clsx } from 'clsx';

export type ProgressBarProps = {
  /** Ignored when `indeterminate` is set. */
  value?: number;
  /**
   * Renders a full-width pulsing fill instead of a fixed-width one, for work
   * that has no total it can be measured against, as opposed to merely an
   * unknown one (e.g. a count of matching kind but uncertain size still gets a
   * real percentage; this is for when the numerator and the only count on hand
   * are not the same unit at all).
   */
  indeterminate?: boolean;
  className?: string;
  size?: 'sm' | 'md';
  label?: string;
};

const sizeClasses = {
  sm: 'h-1.5',
  md: 'h-2',
} as const;

export function ProgressBar({
  value = 0,
  indeterminate = false,
  className,
  size = 'md',
  label,
}: ProgressBarProps) {
  // Clamp value to [0, 100]
  const clamped = Math.min(100, Math.max(0, value));

  return (
    <div
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={clsx(
        'w-full overflow-hidden rounded-full bg-zinc-100',
        sizeClasses[size],
        className,
      )}
    >
      <div
        className={clsx(
          'h-full rounded-full bg-brand-700',
          indeterminate ? 'w-full animate-pulse' : 'transition-all duration-300',
        )}
        style={indeterminate ? undefined : { width: `${clamped}%` }}
      />
    </div>
  );
}
