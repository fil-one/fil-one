import { cn } from '../lib/utils.js';

/**
 * A single pulsing placeholder block. Size it with `className` (`h-*`, `w-*`),
 * and pass one of the four allowed radii to override the default when it stands
 * in for a card or pill. Purely decorative: it carries `aria-hidden`, and the
 * surrounding region is what announces the loading state (see `TableSkeleton`).
 */
export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn('animate-pulse rounded-md bg-zinc-100', className)}
      {...props}
    />
  );
}
