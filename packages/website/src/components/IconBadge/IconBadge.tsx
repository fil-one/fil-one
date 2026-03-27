import { cva, type VariantProps } from 'class-variance-authority';
import type { Icon as PhosphorIcon, IconWeight } from '@phosphor-icons/react';

import { cn } from '../../lib/utils.js';
import { Icon } from '../Icon/index.js';

const iconBadgeVariants = cva('grid shrink-0 place-items-center', {
  variants: {
    variant: {
      info: 'bg-zinc-100 text-zinc-600',
      success: 'bg-green-100 text-green-800',
      warning: 'bg-amber-100 text-amber-800',
      error: 'bg-red-100 text-red-800',
      brand: 'bg-brand-100 text-brand-800',
    },
    size: {
      /** Used in Alert — 36px, md (20px) icon */
      sm: 'size-9',
      /** 40px, md (20px) icon */
      md: 'size-10',
      /** Large hero — 60px, lg (24px) icon */
      lg: 'size-15',
    },
    shape: {
      circle: 'rounded-full',
      square: 'rounded-xl',
    },
  },
  defaultVariants: {
    variant: 'info',
    size: 'sm',
    shape: 'circle',
  },
});

const iconSizeMap = {
  sm: 'md',
  md: 'md',
  lg: 'lg',
} as const satisfies Record<
  NonNullable<VariantProps<typeof iconBadgeVariants>['size']>,
  'md' | 'lg'
>;

export type IconBadgeProps = {
  icon: PhosphorIcon;
  weight?: IconWeight;
  className?: string;
} & VariantProps<typeof iconBadgeVariants>;

export { iconBadgeVariants };

export function IconBadge({
  icon,
  variant,
  size = 'sm',
  shape = 'circle',
  weight,
  className,
}: IconBadgeProps) {
  const resolvedSize = size ?? 'sm';
  return (
    <span className={cn(iconBadgeVariants({ variant, size: resolvedSize, shape }), className)}>
      <Icon component={icon} size={iconSizeMap[resolvedSize]} weight={weight} />
    </span>
  );
}
