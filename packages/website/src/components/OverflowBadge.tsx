import { useEffect, useRef, useState } from 'react';

import { Badge, type BadgeColor } from './Badge';

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

const PANEL_WIDTH_ESTIMATE = 260;

/** A badge that opens a click-triggered popover listing grouped items too numerous to show inline. */
export function OverflowBadge({ label, color = 'grey', sections, testId }: OverflowBadgeProps) {
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

  function handleOpen() {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const left = Math.min(rect.left, window.innerWidth - PANEL_WIDTH_ESTIMATE - 16);
      setPos({ top: rect.bottom + 4, left: Math.max(left, 16) });
    }
    setOpen((o) => !o);
  }

  return (
    <span className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={handleOpen}
        className="cursor-pointer"
      >
        <Badge color={color} size="sm">
          {label}
        </Badge>
      </button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-50 min-w-40 max-w-64 rounded-lg border border-zinc-200 bg-white p-3 shadow-lg"
        >
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
        </div>
      )}
    </span>
  );
}
