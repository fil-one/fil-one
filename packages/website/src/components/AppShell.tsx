import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ListIcon, XIcon, SignOutIcon } from '@phosphor-icons/react/dist/ssr';
import { useQuery } from '@tanstack/react-query';
import { SubscriptionStatus } from '@filone/shared';
import { SidebarNav } from './SidebarNav';
import { Banner } from './Banner';
import { getUsage, getBilling, getMe, logout } from '../lib/api';
import { queryKeys } from '../lib/query-client.js';
import { daysUntil } from '../lib/time.js';

function MobileUserMenu() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: () => getMe() });

  const displayName = me?.name || me?.email || 'User';
  const initial = displayName.charAt(0).toUpperCase();

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`User menu for ${displayName}`}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-11 w-11 items-center justify-center rounded-lg"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
          {initial}
        </span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute left-0 top-12 z-50 w-52 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg"
        >
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium text-zinc-900">{displayName}</p>
            {me?.orgName && <p className="truncate text-xs text-zinc-500">{me.orgName}</p>}
          </div>
          <div className="my-1 border-t border-zinc-100" />
          <button
            type="button"
            role="menuitem"
            onClick={logout}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            <SignOutIcon size={18} className="flex-shrink-0 text-zinc-400" />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const hamburgerButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerId = useId();

  const { data: usage } = useQuery({ queryKey: queryKeys.usage, queryFn: getUsage });
  const { data: billing } = useQuery({ queryKey: queryKeys.billing, queryFn: getBilling });

  const tenantStatus = usage?.tenantStatus;
  const isGracePeriod = billing?.subscription.status === SubscriptionStatus.GracePeriod;
  const graceDays = billing?.subscription.gracePeriodEndsAt
    ? daysUntil(billing.subscription.gracePeriodEndsAt)
    : null;

  const closeDrawer = useCallback(() => {
    setMobileOpen(false);
    hamburgerButtonRef.current?.focus();
  }, []);

  // Move focus to close button when drawer opens
  useEffect(() => {
    if (mobileOpen) closeButtonRef.current?.focus();
  }, [mobileOpen]);

  // Lock body scroll when drawer is open; compensate for scrollbar width to prevent layout shift
  useEffect(() => {
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = mobileOpen ? 'hidden' : '';
    document.body.style.paddingRight = mobileOpen ? `${scrollbarWidth}px` : '';
    return () => {
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
    };
  }, [mobileOpen]);

  // Close on Escape; trap Tab focus within the drawer while open
  useEffect(() => {
    if (!mobileOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closeDrawer();
        return;
      }
      if (e.key !== 'Tab') return;
      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusable = drawer.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [mobileOpen, closeDrawer]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {tenantStatus === 'write-locked' && (
        <Banner variant="warning" action={{ label: 'Upgrade', href: '/billing' }}>
          {isGracePeriod
            ? `Your free trial has expired.${graceDays !== null ? ` ${graceDays} days left` : ''} to upgrade or download your data.`
            : 'Storage limit exceeded. Uploads are disabled. Delete files or upgrade to resume.'}
        </Banner>
      )}
      {tenantStatus === 'disabled' && (
        <Banner variant="error" action={{ label: 'Manage account', href: '/billing' }}>
          Account disabled. Visit billing to restore access.
        </Banner>
      )}
      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar — unchanged */}
        <div
          className={`hidden flex-shrink-0 transition-all duration-200 lg:block ${collapsed ? 'w-20' : 'w-60'}`}
        >
          <SidebarNav collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
        </div>

        {/* Mobile drawer backdrop */}
        <div
          data-testid="drawer-backdrop"
          aria-hidden="true"
          onClick={closeDrawer}
          className={`fixed inset-0 z-30 bg-black/40 transition-opacity duration-200 motion-reduce:duration-0 lg:hidden ${
            mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        />

        {/* Mobile drawer */}
        <div
          ref={drawerRef}
          id={drawerId}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className={`fixed inset-y-0 right-0 z-40 flex w-72 flex-col bg-white shadow-xl transition-transform duration-200 motion-reduce:duration-0 lg:hidden ${
            mobileOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
          // Hide from assistive technology when closed
          inert={!mobileOpen || undefined}
        >
          {/* Drawer header: close */}
          <div className="flex h-14 flex-shrink-0 items-center justify-end border-b border-zinc-200 px-3">
            <button
              ref={closeButtonRef}
              type="button"
              onClick={closeDrawer}
              aria-label="Close"
              className="-mr-1 flex h-11 w-11 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
            >
              <XIcon size={20} />
            </button>
          </div>

          {/* Nav — scrollable, no user profile inside the drawer */}
          <div className="flex-1 overflow-y-auto">
            <SidebarNav
              collapsed={false}
              onToggle={() => {}}
              onClose={closeDrawer}
              showUserProfile={false}
            />
          </div>
        </div>

        <main className="flex-1 overflow-auto bg-zinc-50">
          {/* Mobile top bar */}
          <div className="sticky top-0 z-20 flex h-14 flex-shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-3 lg:hidden">
            <MobileUserMenu />
            <button
              ref={hamburgerButtonRef}
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={mobileOpen}
              aria-controls={drawerId}
              className="-mr-1 flex h-11 w-11 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100"
            >
              <ListIcon size={20} />
            </button>
          </div>

          {children}
          <div className="h-10 shrink-0" aria-hidden="true" />
        </main>
      </div>
    </div>
  );
}
