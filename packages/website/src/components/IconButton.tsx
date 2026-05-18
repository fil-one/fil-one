import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import type { ComponentType, SVGProps } from 'react';
import { forwardRef } from 'react';

import { cn } from '../lib/utils';
import { Tooltip } from './Tooltip';
import type { TooltipSide } from './Tooltip';

type IconButtonSize = 'sm' | 'md' | 'lg';

type IconButtonProps = {
  icon: PhosphorIcon | ComponentType<SVGProps<SVGSVGElement>>;
  'aria-label': string;
  size?: IconButtonSize;
  tooltip?: string;
  tooltipSide?: TooltipSide;
} & Omit<React.ComponentProps<'button'>, 'children'>;

const sizeStyles: Record<IconButtonSize, { padding: string; iconSize: number }> = {
  sm: { padding: 'p-1', iconSize: 14 },
  md: { padding: 'p-1.5', iconSize: 18 },
  lg: { padding: 'p-2', iconSize: 22 },
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon: Icon, size = 'md', className, tooltip, tooltipSide, ...rest }, ref) => {
    const { padding, iconSize } = sizeStyles[size];
    const button = (
      <button
        ref={ref}
        type="button"
        {...rest}
        className={cn(
          'rounded text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700',
          'disabled:cursor-not-allowed disabled:opacity-50',
          padding,
          className,
        )}
      >
        <Icon width={iconSize} height={iconSize} aria-hidden="true" />
      </button>
    );

    if (tooltip) {
      return (
        <Tooltip content={tooltip} side={tooltipSide}>
          {button}
        </Tooltip>
      );
    }
    return button;
  },
);

IconButton.displayName = 'IconButton';
