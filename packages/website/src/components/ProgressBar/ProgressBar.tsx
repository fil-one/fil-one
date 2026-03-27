import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils';

const progressBarVariants = cva('w-full overflow-hidden rounded-full bg-zinc-100', {
  variants: {
    size: {
      sm: 'h-1.5',
      md: 'h-2',
    },
  },
  defaultVariants: { size: 'md' },
});

export type ProgressBarProps = {
  value: number;
  className?: string;
  label?: string;
} & VariantProps<typeof progressBarVariants>;

export function ProgressBar({ value, className, size, label }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, value));

  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn(progressBarVariants({ size }), className)}
    >
      <div
        className="h-full rounded-full bg-brand-700 transition-all duration-300"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
