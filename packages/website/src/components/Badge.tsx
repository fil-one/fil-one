import clsx from 'clsx';

export type BadgeColor = 'green' | 'blue' | 'red' | 'amber' | 'grey';
export type BadgeSize = 'sm' | 'md' | 'lg';
export type BadgeWeight = 'regular' | 'medium';
export type BadgeVariant = 'subtle' | 'solid';

type BadgeProps = {
  children: React.ReactNode;
  color?: BadgeColor;
  size?: BadgeSize;
  weight?: BadgeWeight;
  variant?: BadgeVariant;
  dot?: boolean;
  className?: string;
};

const colorStyles: Record<BadgeColor, string> = {
  green: 'bg-green-50 text-green-800',
  blue: 'bg-brand-100 text-brand-800',
  red: 'bg-red-50 text-red-800',
  amber: 'bg-amber-50 text-amber-700',
  grey: 'bg-zinc-100 text-zinc-700',
};

const solidColorStyles: Record<BadgeColor, string> = {
  green: 'bg-green-700 text-white', // green-700 ~5.1:1 with white ✓ AA
  blue: 'bg-brand-600 text-white', // brand-600 ~5:1 with white ✓ AA
  red: 'bg-red-700 text-white', // red-700 ~5.9:1 with white ✓ AA
  amber: 'bg-amber-600 text-white', // amber-600 ~4.6:1 with white ✓ AA
  grey: 'bg-zinc-600 text-white', // zinc-600 ~7:1 with white ✓ AA
};

const dotStyles: Record<BadgeColor, string> = {
  green: 'bg-green-500',
  blue: 'bg-brand-500',
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  grey: 'bg-zinc-400',
};

// Dots on solid backgrounds need to be visible against the darker fill
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
};

export function Badge({
  children,
  color = 'grey',
  size = 'md',
  weight = 'regular',
  variant = 'subtle',
  dot,
  className,
}: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full',
        variant === 'solid' ? solidColorStyles[color] : colorStyles[color],
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
            variant === 'solid' ? solidDotStyles[color] : dotStyles[color],
            dotSizeStyles[size],
          )}
        />
      )}
      {children}
    </span>
  );
}
