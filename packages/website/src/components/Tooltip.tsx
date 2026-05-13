import { useLayoutEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';

export type TooltipSide = 'right' | 'top' | 'bottom' | 'left';

type TooltipProps = {
  children: React.ReactNode;
  content: React.ReactNode;
  side?: TooltipSide;
  className?: string;
};

type Rect = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
};

function computePosition(side: TooltipSide, trigger: Rect, tw: number, th: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 8;
  let top = 0;
  let left = 0;

  if (side === 'bottom' || side === 'top') {
    const spaceBelow = vh - trigger.bottom;
    const spaceAbove = trigger.top;
    const useBottom = side === 'bottom' ? spaceBelow >= th + gap : spaceAbove < th + gap;
    top = useBottom ? trigger.height + gap : -(th + gap);
    left = trigger.width / 2 - tw / 2;
    const absLeft = trigger.left + left;
    if (absLeft < 8) left -= absLeft - 8;
    if (absLeft + tw > vw - 8) left -= absLeft + tw - (vw - 8);
  } else {
    const spaceRight = vw - trigger.right;
    const spaceLeft = trigger.left;
    const useRight = side === 'right' ? spaceRight >= tw + gap : spaceLeft < tw + gap;
    left = useRight ? trigger.width + gap : -(tw + gap);
    top = trigger.height / 2 - th / 2;
  }

  return { top, left };
}

export function Tooltip({ children, content, side = 'right', className }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!visible || !containerRef.current || !tooltipRef.current) return;
    const trigger = containerRef.current.getBoundingClientRect();
    const tooltip = tooltipRef.current;
    const { top, left } = computePosition(side, trigger, tooltip.offsetWidth, tooltip.offsetHeight);
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }, [visible, side]);

  return (
    <div
      ref={containerRef}
      className={clsx('relative', className)}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div
          ref={tooltipRef}
          role="tooltip"
          className="pointer-events-none absolute z-50 w-max max-w-[220px] whitespace-normal rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs leading-relaxed text-zinc-900 shadow-md"
        >
          {content}
        </div>
      )}
    </div>
  );
}
