import { useState, useEffect, useRef } from 'react';
import { BookOpenIcon, SignOutIcon } from '@phosphor-icons/react/dist/ssr';
import { DOCS_URL } from '@filone/shared';
import type { MeResponse } from '@filone/shared';
import { getMe, logout } from '../lib/api.js';
import { useToast } from './Toast';

export function AppHeader() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    getMe()
      .then(setMe)
      .catch(() => {
        toast.error('Failed to refresh user info');
      });
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  const initial = me?.name?.charAt(0)?.toUpperCase() ?? me?.email?.charAt(0)?.toUpperCase() ?? 'U';

  return (
    <header className="flex h-14 flex-shrink-0 items-center border-b border-zinc-200 bg-white px-4 gap-4">
      {/* Spacer pushes right-side icons to the right */}
      <div className="flex-1" />

      {/* Right-side: avatar with dropdown */}
      <div className="relative">
        <button
          ref={buttonRef}
          type="button"
          aria-label="User menu"
          onClick={() => setMenuOpen((prev) => !prev)}
          className="flex h-8 w-8 items-center justify-center rounded-full overflow-hidden focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1"
        >
          {me?.picture ? (
            <img
              src={me.picture}
              alt=""
              className="h-8 w-8 rounded-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-medium text-white">
              {initial}
            </span>
          )}
        </button>

        {menuOpen && (
          <div
            ref={menuRef}
            className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50"
          >
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
            >
              <BookOpenIcon size={16} />
              Documentation
            </a>
            <button
              type="button"
              onClick={logout}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
            >
              <SignOutIcon size={16} />
              Log out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
