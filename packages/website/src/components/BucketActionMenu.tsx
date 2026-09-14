import { useEffect, useRef, useState } from 'react';
import { DotsThreeIcon, ProhibitIcon } from '@phosphor-icons/react/dist/ssr';

import type { IconProps } from './Icon';

export type BucketAction = {
  label: string;
  icon: IconProps['component'];
  onSelect: () => void;
  /** Rendered muted and inert, with `hint` explaining why. */
  disabled?: boolean;
  /** Short trailing note, e.g. why a disabled action is unavailable. */
  hint?: string;
  /** For tests and analytics; defaults to a slug of the label. */
  testId?: string;
};

export type BucketActionMenuProps = {
  /** Actions in menu order. */
  actions?: BucketAction[];
  /**
   * Shorthand for the RAG buckets tab's single "Stop indexing" action. Ignored
   * when `actions` is given.
   */
  onDisable?: () => void;
};

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Dropdown menu of per-bucket actions with click-outside dismissal. */
export function BucketActionMenu({ actions, onDisable }: BucketActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const items: BucketAction[] =
    actions ??
    (onDisable
      ? [
          {
            label: 'Stop indexing',
            icon: ProhibitIcon,
            onSelect: onDisable,
            testId: 'bucket-action-menu-disable',
          },
        ]
      : []);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function handleOpen() {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen((o) => !o);
  }

  return (
    <div data-testid="bucket-action-menu" className="relative inline-block">
      <button
        ref={buttonRef}
        data-testid="bucket-action-menu-trigger"
        type="button"
        aria-label="Bucket actions"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={handleOpen}
        className="rounded p-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
      >
        <DotsThreeIcon weight="bold" width={18} height={18} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          data-testid="bucket-action-menu-list"
          role="menu"
          style={{ top: pos.top, right: pos.right }}
          className="fixed z-50 w-auto min-w-36 rounded-lg border border-zinc-200 bg-white py-1 shadow-md"
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                data-testid={item.testId ?? `bucket-action-menu-${slug(item.label)}`}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs whitespace-nowrap text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-zinc-400"
              >
                <Icon size={13} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
                {item.label}
                {item.hint && <span className="ml-auto pl-3 text-zinc-400">{item.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
