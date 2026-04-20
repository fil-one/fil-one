import { useState } from 'react';
import { clsx } from 'clsx';

type TooltipSide = 'right' | 'top' | 'bottom' | 'left';

type TooltipProps = {
  children: React.ReactNode;
  content: string;
  side?: TooltipSide;
  className?: string;
};

const sideStyles: Record<TooltipSide, string> = {
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
};

export function Tooltip({ children, content, side = 'right', className }: TooltipProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div
      className={clsx('relative', className)}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div
          role="tooltip"
          className={clsx(
            'pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900 shadow-md',
            sideStyles[side],
          )}
        >
          {content}
        </div>
      )}
    </div>
  );
}
