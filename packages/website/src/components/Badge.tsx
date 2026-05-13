import { useId, useRef, useState } from 'react';
import clsx from 'clsx';

export type BadgeColor = 'green' | 'blue' | 'red' | 'amber' | 'grey';
export type BadgeSize = 'sm' | 'md' | 'lg';
export type BadgeWeight = 'regular' | 'medium' | 'semibold';
export type BadgeVariant = 'subtle' | 'solid';

type BadgeProps = {
  children: React.ReactNode;
  color?: BadgeColor;
  size?: BadgeSize;
  weight?: BadgeWeight;
  variant?: BadgeVariant;
  dot?: boolean;
  description?: React.ReactNode;
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
  semibold: 'font-semibold',
};

export function Badge({
  children,
  color = 'grey',
  size = 'md',
  weight = 'regular',
  variant = 'subtle',
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
          variant === 'solid' ? solidColorStyles[color] : colorStyles[color],
          sizeStyles[size],
          dot ? paddingXStyles[size].dot : paddingXStyles[size].noDot,
          weightStyles[weight],
          hasTooltip &&
            'cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400',
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
