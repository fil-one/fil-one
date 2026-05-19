import clsx from 'clsx';

import { Tooltip } from './Tooltip';

export type BadgeColor = 'green' | 'blue' | 'red' | 'grey' | 'amber';
export type BadgeSize = 'sm' | 'md' | 'lg';
export type BadgeWeight = 'regular' | 'medium' | 'semibold';
export type BadgeStrength = 'subtle' | 'strong';
export type BadgeVariant = 'default' | 'solid';

type BadgeProps = {
  children: React.ReactNode;
  color?: BadgeColor;
  size?: BadgeSize;
  weight?: BadgeWeight;
  strength?: BadgeStrength;
  variant?: BadgeVariant;
  dot?: boolean;
  description?: React.ReactNode;
  className?: string;
};

const colorStyles: Record<BadgeStrength, Record<BadgeColor, string>> = {
  subtle: {
    green: 'bg-green-50 text-green-800',
    blue: 'bg-brand-50 text-brand-800',
    red: 'bg-red-50 text-red-800',
    grey: 'bg-zinc-100 text-zinc-700',
    amber: 'bg-amber-50 text-amber-800',
  },
  strong: {
    green: 'bg-green-100 text-green-900',
    blue: 'bg-brand-100 text-brand-900',
    red: 'bg-red-100 text-red-900',
    grey: 'bg-zinc-200 text-zinc-800',
    amber: 'bg-amber-100 text-amber-900',
  },
};

const solidColorStyles: Record<BadgeColor, string> = {
  green: 'bg-green-700 text-white',
  blue: 'bg-brand-600 text-white',
  red: 'bg-red-700 text-white',
  amber: 'bg-amber-700 text-white',
  grey: 'bg-zinc-600 text-white',
};

const dotStyles: Record<BadgeColor, string> = {
  green: 'bg-green-500',
  blue: 'bg-brand-500',
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  grey: 'bg-zinc-400',
};

const solidDotStyles: Record<BadgeColor, string> = {
  green: 'bg-white/60',
  blue: 'bg-white/60',
  red: 'bg-white/60',
  amber: 'bg-white/60',
  grey: 'bg-white/60',
};

const sizeStyles: Record<BadgeSize, string> = {
  sm: 'text-xs py-0.5 gap-1',
  md: 'text-sm py-0.5 gap-1.5',
  lg: 'text-sm py-1 gap-1.5',
};

const paddingXStyles: Record<BadgeSize, { dot: string; noDot: string }> = {
  sm: { dot: 'px-1.5', noDot: 'px-2' },
  md: { dot: 'px-2', noDot: 'px-2.5' },
  lg: { dot: 'px-2.5', noDot: 'px-3' },
};

const dotSizeStyles: Record<BadgeSize, string> = {
  sm: 'size-1.5',
  md: 'size-2',
  lg: 'size-2',
};

const weightStyles: Record<BadgeWeight, string> = {
  regular: 'font-normal',
  medium: 'font-medium',
  semibold: 'font-semibold',
};

export function Badge({
  children,
  color = 'grey',
  size = 'md',
  weight = 'medium',
  strength = 'subtle',
  variant = 'default',
  dot,
  description,
  className,
}: BadgeProps) {
  const isSolid = variant === 'solid';

  const badge = (
    <span
      className={clsx(
        'inline-flex items-center rounded-full',
        isSolid ? solidColorStyles[color] : colorStyles[strength][color],
        sizeStyles[size],
        dot ? paddingXStyles[size].dot : paddingXStyles[size].noDot,
        weightStyles[weight],
        className,
      )}
    >
      {dot && (
        <span
          className={clsx(
            'rounded-full shrink-0',
            isSolid ? solidDotStyles[color] : dotStyles[color],
            dotSizeStyles[size],
          )}
        />
      )}
      {children}
    </span>
  );

  if (description !== undefined) {
    return (
      <Tooltip content={description} side="bottom">
        {badge}
      </Tooltip>
    );
  }

  return badge;
}
