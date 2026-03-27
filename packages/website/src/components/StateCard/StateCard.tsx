import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils.js';

const stateCardVariants = cva('flex flex-col items-center justify-center rounded-xl px-6 py-10', {
  variants: {
    border: {
      dashed: 'border border-dashed border-(--state-card-border-color)',
      solid: 'border border-solid border-(--state-card-border-color)',
    },
    background: {
      subtle: 'bg-(--state-card-background-color)',
    },
  },
});

export type StateCardProps = {
  children: React.ReactNode;
  className?: string;
} & VariantProps<typeof stateCardVariants>;

export { stateCardVariants };

export function StateCard({ children, border, background, className }: StateCardProps) {
  return <div className={cn(stateCardVariants({ border, background }), className)}>{children}</div>;
}
