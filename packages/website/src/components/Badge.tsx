import clsx from 'clsx';

export type BadgeColor = 'green' | 'blue' | 'red' | 'grey';
export type BadgeSize = 'sm' | 'md' | 'lg';
export type BadgeWeight = 'regular' | 'medium';

type BadgeProps = {
  children: React.ReactNode;
  color?: BadgeColor;
  size?: BadgeSize;
  weight?: BadgeWeight;
  dot?: boolean;
  className?: string;
};

const colorStyles: Record<BadgeColor, string> = {
  green: 'bg-green-50 text-green-800',
  blue: 'bg-brand-50 text-brand-800',
  red: 'bg-red-50 text-red-800',
  grey: 'bg-zinc-100 text-zinc-700',
};

const dotStyles: Record<BadgeColor, string> = {
  green: 'bg-green-500',
  blue: 'bg-brand-500',
  red: 'bg-red-500',
  grey: 'bg-zinc-400',
};

const sizeStyles: Record<BadgeSize, string> = {
  sm: 'text-xs px-1.5 py-0.5 gap-1',
  md: 'text-sm px-2 py-0.5 gap-1.5',
  lg: 'text-sm px-2.5 py-1 gap-1.5',
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
  dot,
  className,
}: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full',
        colorStyles[color],
        sizeStyles[size],
        weightStyles[weight],
        className,
      )}
    >
      {dot && (
        <span className={clsx('rounded-full shrink-0', dotStyles[color], dotSizeStyles[size])} />
      )}
      {children}
    </span>
  );
}
