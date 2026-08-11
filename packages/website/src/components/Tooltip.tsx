import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';

export type TooltipSide = 'right' | 'top' | 'bottom' | 'left';

type TooltipProps = {
  children: React.ReactNode;
  content: React.ReactNode;
  side?: TooltipSide;
  className?: string;
  /**
   * Makes the trigger a tab stop, for when the wrapped content isn't focusable
   * on its own (plain text, an icon). Without it a keyboard user has no way to
   * reach the tooltip, so set it whenever the content isn't repeated elsewhere.
   */
  focusable?: boolean;
  /** Announced label for a `focusable` trigger. Defaults to the tooltip text. */
  label?: string;
};

type Rect = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
};

// Clamp `value` into [min, max], preferring min when the box is wider/taller
// than the available space (max < min), so the clamp can't push it off-screen.
function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

function computePosition(side: TooltipSide, trigger: Rect, tw: number, th: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 8;
  const inset = 8;
  let top = 0;
  let left = 0;

  if (side === 'bottom' || side === 'top') {
    const spaceBelow = vh - trigger.bottom;
    const spaceAbove = trigger.top;
    const useBottom = side === 'bottom' ? spaceBelow >= th + gap : spaceAbove < th + gap;
    top = useBottom ? trigger.bottom + gap : trigger.top - th - gap;
    left = trigger.left + trigger.width / 2 - tw / 2;
  } else {
    const spaceRight = vw - trigger.right;
    const spaceLeft = trigger.left;
    const useRight = side === 'right' ? spaceRight >= tw + gap : spaceLeft < tw + gap;
    left = useRight ? trigger.right + gap : trigger.left - tw - gap;
    top = trigger.top + trigger.height / 2 - th / 2;
  }

  // Clamp both axes so the tooltip stays within the viewport even when the
  // flip logic can't find room on either side (e.g. narrow viewports).
  left = clamp(left, inset, vw - inset - tw);
  top = clamp(top, inset, vh - inset - th);

  return { top, left };
}

export function Tooltip({
  children,
  content,
  side = 'right',
  className,
  focusable,
  label,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!visible) return;

    const position = () => {
      if (!containerRef.current || !tooltipRef.current) return;
      const trigger = containerRef.current.getBoundingClientRect();
      const tooltip = tooltipRef.current;
      const { top, left } = computePosition(
        side,
        trigger,
        tooltip.offsetWidth,
        tooltip.offsetHeight,
      );
      tooltip.style.top = `${top}px`;
      tooltip.style.left = `${left}px`;
    };

    position();

    // The tooltip is fixed-positioned in a body portal, so it won't track the
    // trigger on its own. Reposition (rAF-throttled) while visible. Capture
    // phase catches scrolling of any ancestor container, not just the page.
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    };
    // Escape dismisses it without moving focus, which is what a keyboard user
    // expects of a tooltip that's covering something they want to read.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setVisible(false);
    };

    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible, side]);

  return (
    <div
      ref={containerRef}
      className={clsx(
        'relative inline-block',
        focusable && 'focus-visible:brand-outline',
        className,
      )}
      // React's onFocus/onBlur map to focusin/focusout, so a focusable child
      // surfaces the tooltip without the wrapper needing to be the tab stop.
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
      {...(focusable && {
        tabIndex: 0,
        role: 'note',
        'aria-label': label ?? (typeof content === 'string' ? content : undefined),
      })}
    >
      {children}
      {visible &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            className="pointer-events-none fixed z-50 w-max max-w-[220px] whitespace-normal rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs leading-relaxed text-zinc-900 shadow-md"
          >
            {content}
          </div>,
          document.body,
        )}
    </div>
  );
}
