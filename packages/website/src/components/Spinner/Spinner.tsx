import { cn } from '../../lib/utils';

export type SpinnerProps = {
  size?: number;
  className?: string;
} & ({ message: string; ariaLabel?: string } | { message?: never; ariaLabel: string });

export function Spinner({ message, ariaLabel, size = 20, className }: SpinnerProps) {
  const accessibleLabel = ariaLabel || message;
  const strokeWidth = Math.max(2, size * 0.1);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className={cn('flex flex-col items-center gap-3', className)} role="status">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        fill="none"
        className="shrink-0 animate-spin"
        aria-label={accessibleLabel}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          className="text-brand-700"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * 0.75}
        />
      </svg>
      {message && <p>{message}</p>}
    </div>
  );
}
