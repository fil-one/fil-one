import { clsx } from 'clsx';
import { type IconProps } from './Icon';
import { IconBox, type IconBoxColor } from './IconBox';

export type EmptyStateCardProps = {
  icon: IconProps['component'];
  iconColor?: IconBoxColor;
  title: React.ReactNode;
  description: string;
  children?: React.ReactNode;
  /** False when a parent `Card` already supplies the border/background, so this doesn't nest a card inside a card. */
  bordered?: boolean;
};

export function EmptyStateCard({
  icon,
  iconColor = 'blue',
  title,
  description,
  children,
  bordered = true,
}: EmptyStateCardProps) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center px-6 py-16 text-center',
        bordered && 'rounded-xl border border-zinc-200 bg-white',
      )}
    >
      <IconBox icon={icon} size="md" color={iconColor} className="mb-4" />
      <p className="mb-1 text-sm font-medium text-zinc-900">{title}</p>
      <p className="mb-4 max-w-xs text-sm text-zinc-500">{description}</p>
      {children}
    </div>
  );
}
