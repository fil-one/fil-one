import { clsx } from 'clsx';

export type ProgressBarProps = {
  value: number;
  className?: string;
  size?: 'sm' | 'md';
  label?: string;
};

const sizeClasses = {
  sm: 'h-1.5',
  md: 'h-2',
} as const;

export function ProgressBar({ value, className, size = 'md', label }: ProgressBarProps) {
  // Clamp value to [0, 100]
  const clamped = Math.min(100, Math.max(0, value));

  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
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
        className="h-full rounded-full bg-brand-700 transition-all duration-300"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
