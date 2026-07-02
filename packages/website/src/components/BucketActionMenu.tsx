import { useEffect, useRef, useState } from 'react';
import { DotsThreeIcon, ProhibitIcon } from '@phosphor-icons/react/dist/ssr';

export type BucketActionMenuProps = {
  onDisable: () => void;
};

/** Dropdown menu of per-bucket actions with click-outside dismissal. */
export function BucketActionMenu({ onDisable }: BucketActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
          className="fixed z-50 w-40 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
        >
          <button
            data-testid="bucket-action-menu-disable"
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDisable();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            <ProhibitIcon size={14} aria-hidden="true" />
            Disable
          </button>
        </div>
      )}
    </div>
  );
}
