import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

import { Badge, type BadgeColor } from './Badge';

const PANEL_WIDTH_ESTIMATE = 260;

/** Open state, position and click-outside dismissal for a button that opens a floating panel below it. */
function usePopoverTrigger() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function toggle() {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const left = Math.min(rect.left, window.innerWidth - PANEL_WIDTH_ESTIMATE - 16);
      setPos({ top: rect.bottom + 4, left: Math.max(left, 16) });
    }
    setOpen((o) => !o);
  }

  return { open, pos, triggerRef, panelRef, toggle };
}

/**
 * The floating panel itself, anchored below its trigger. Stays mounted while
 * closed and animates opacity/scale instead of mounting on open, so it fades
 * and grows from the trigger's corner rather than snapping into view.
 */
function PopoverPanel({
  open,
  pos,
  panelRef,
  children,
}: {
  open: boolean;
  pos: { top: number; left: number };
  panelRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-hidden={!open}
      style={{ top: pos.top, left: pos.left }}
      className={clsx(
        'fixed z-50 min-w-40 max-w-64 origin-top-left rounded-lg border border-zinc-200 bg-white p-3 shadow-lg transition duration-150 ease-out',
        open ? 'scale-100 opacity-100' : 'pointer-events-none scale-95 opacity-0',
      )}
    >
      {children}
    </div>
  );
}

export type OverflowSection = {
  title?: string;
  items: { key: string; label: string }[];
};

export type OverflowBadgeProps = {
  label: string;
  color?: BadgeColor;
  sections: OverflowSection[];
  testId?: string;
};

/** A badge that opens a click-triggered popover listing grouped items too numerous to show inline. */
export function OverflowBadge({ label, color = 'grey', sections, testId }: OverflowBadgeProps) {
  const { open, pos, triggerRef, panelRef, toggle } = usePopoverTrigger();

  return (
    <span className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={toggle}
        className="cursor-pointer"
      >
        <Badge color={color} size="sm">
          {label}
        </Badge>
      </button>
      <PopoverPanel open={open} pos={pos} panelRef={panelRef}>
        <div className="flex flex-col gap-3">
          {sections.map((section, i) => (
            <div key={section.title ?? i}>
              {section.title && (
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  {section.title}
                </p>
              )}
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => (
                  <li key={item.key} className="text-xs text-zinc-700">
                    {item.label}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </PopoverPanel>
    </span>
  );
}
