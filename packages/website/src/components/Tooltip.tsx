import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';

type TooltipSide = 'right' | 'top' | 'bottom' | 'left';

type TooltipProps = {
  children: React.ReactNode;
  content: React.ReactNode;
  side?: TooltipSide;
  className?: string;
};

function getPosition(rect: DOMRect, side: TooltipSide) {
  const gap = 6;
  switch (side) {
    case 'bottom':
      return { top: rect.bottom + gap, left: rect.left + rect.width / 2 };
    case 'top':
      return { top: rect.top - gap, left: rect.left + rect.width / 2 };
    case 'right':
      return { top: rect.top + rect.height / 2, left: rect.right + gap };
    case 'left':
      return { top: rect.top + rect.height / 2, left: rect.left - gap };
  }
}

const transformStyles: Record<TooltipSide, string> = {
  bottom: '-translate-x-1/2',
  top: '-translate-x-1/2 -translate-y-full',
  right: '-translate-y-1/2',
  left: '-translate-x-full -translate-y-1/2',
};

export function Tooltip({ children, content, side = 'right', className }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);

  function show() {
    if (triggerRef.current) {
      setPos(getPosition(triggerRef.current.getBoundingClientRect(), side));
    }
    setVisible(true);
  }

  return (
    <div
      ref={triggerRef}
      className={clsx('relative inline-flex', className)}
      onMouseEnter={show}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible &&
        createPortal(
          <div
            role="tooltip"
            style={{ top: pos.top, left: pos.left }}
            className={clsx(
              'pointer-events-none fixed z-50 w-max rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900 shadow-md',
              transformStyles[side],
            )}
          >
            {content}
          </div>,
          document.body,
        )}
    </div>
  );
}
