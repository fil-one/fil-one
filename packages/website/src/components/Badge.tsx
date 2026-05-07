import { useId, useRef, useState } from 'react';
import clsx from 'clsx';

export type BadgeColor = 'green' | 'blue' | 'red' | 'grey' | 'amber';
export type BadgeSize = 'sm' | 'md' | 'lg';
export type BadgeWeight = 'regular' | 'medium' | 'semibold';

type BadgeProps = {
  children: React.ReactNode;
  color?: BadgeColor;
  size?: BadgeSize;
  weight?: BadgeWeight;
  dot?: boolean;
  description?: React.ReactNode;
  className?: string;
};

const colorStyles: Record<BadgeColor, string> = {
  green: 'bg-green-50 text-green-800',
  blue: 'bg-brand-50 text-brand-800',
  red: 'bg-red-50 text-red-800',
  grey: 'bg-zinc-100 text-zinc-700',
  amber: 'bg-amber-50 text-amber-800',
};

const dotStyles: Record<BadgeColor, string> = {
  green: 'bg-green-500',
  blue: 'bg-brand-500',
  red: 'bg-red-500',
  grey: 'bg-zinc-400',
  amber: 'bg-amber-500',
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
  semibold: 'font-semibold',
};

export function Badge({
  children,
  color = 'grey',
  size = 'md',
  weight = 'regular',
  dot,
  description,
  className,
}: BadgeProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLElement>(null);
  const tooltipId = useId();
  const hasTooltip = description !== undefined;

  function show() {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 6, left: rect.left + rect.width / 2 });
    }
    setVisible(true);
  }

  function hide() {
    setVisible(false);
  }

  const Tag = hasTooltip ? 'button' : 'span';

  return (
    <>
      <Tag
        ref={triggerRef as React.RefObject<HTMLButtonElement & HTMLSpanElement>}
        {...(hasTooltip && {
          type: 'button' as const,
          onMouseEnter: show,
          onMouseLeave: hide,
          onFocus: show,
          onBlur: hide,
          onClick: () => (visible ? hide() : show()),
          'aria-describedby': visible ? tooltipId : undefined,
          'aria-expanded': visible,
        })}
        className={clsx(
          'inline-flex items-center rounded-full',
          colorStyles[color],
          sizeStyles[size],
          weightStyles[weight],
          hasTooltip &&
            'cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400',
          className,
        )}
      >
        {dot && (
          <span className={clsx('rounded-full shrink-0', dotStyles[color], dotSizeStyles[size])} />
        )}
        {children}
      </Tag>
      {hasTooltip && visible && (
        <div
          id={tooltipId}
          role="tooltip"
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-50 -translate-x-1/2"
        >
          <div className="w-max max-w-56 rounded-lg border border-zinc-200 bg-white px-3 py-2 shadow-lg">
            {description}
          </div>
        </div>
      )}
    </>
  );
}
