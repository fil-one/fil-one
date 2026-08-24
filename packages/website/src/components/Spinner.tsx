import clsx from 'clsx';

type SpinnerProps = {
  size?: number;
  /**
   * Colour of the arc, as a text-colour class. Defaults to brand blue, which is
   * right on a page or a card but wrong inside a coloured control, where the
   * spinner should take the control's own foreground (`text-current`).
   */
  colorClassName?: string;
} & ({ message: string; ariaLabel?: string } | { message?: never; ariaLabel: string });

export function Spinner({
  message,
  ariaLabel,
  size = 52,
  colorClassName = 'text-brand-600',
}: SpinnerProps) {
  const accessibleLabel = ariaLabel || message;
  const strokeWidth = Math.max(2, size * 0.07);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const arc = circumference * 0.75;

  return (
    <div className="flex flex-col items-center gap-3" role="status">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-label={accessibleLabel}
        className={clsx('animate-spin', colorClassName)}
        style={{ animationDuration: '0.8s', animationTimingFunction: 'linear' }}
      >
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="opacity-20"
        />
        {/* Arc */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${arc} ${circumference - arc}`}
          strokeDashoffset={0}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {message && <p className="text-xs leading-relaxed text-zinc-500">{message}</p>}
    </div>
  );
}
