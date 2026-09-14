import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ListIcon, XIcon, SignOutIcon, SidebarSimpleIcon } from '@phosphor-icons/react/dist/ssr';
import { useQuery } from '@tanstack/react-query';
import { SubscriptionStatus } from '@filone/shared';
import { SidebarNav } from './SidebarNav';
import { Banner } from './Banner';
import { UserAvatar } from './UserAvatar';
import { OrgSwitcher } from './OrgSwitcher';
import { ReportBugButton } from './ReportBugButton';
import { SystemStatusPill } from './SystemStatusPill';
import { Tooltip } from './Tooltip';
import { getUsage, getBilling, getMe, logout } from '../lib/api';
import { monogramFromName } from '../lib/monogram.js';
import { queryKeys, USAGE_STALE_TIME } from '../lib/query-client.js';
import { useHasPermission } from '../lib/use-permissions.js';
import { daysUntil, pluralizeDays } from '../lib/time.js';

function MobileUserMenu() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: () => getMe() });

  const displayName = me?.name || me?.email || 'User';
  const initial = monogramFromName(displayName);

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
        id="mobile-user-menu-button"
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`User menu for ${displayName}`}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-11 w-11 items-center justify-center rounded-lg"
      >
        <UserAvatar src={me?.picture} initial={initial} />
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
          <OrgSwitcher
            memberships={me?.memberships}
            activeOrgId={me?.orgId}
            inMenu
            testId="mobile-org-switcher"
            onClose={() => setOpen(false)}
          />
          <button
            type="button"
            role="menuitem"
            id="mobile-user-menu-logout-button"
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

/**
 * What the org's account state means for the caller in front of it.
 *
 * Why a tenant is write-locked is a billing fact, and `billing.view` is what
 * says whether the console may know it. Without that permission the old copy
 * guessed: a Member on a past-due account was told the storage limit was
 * exceeded — a specific, wrong reason — and pointed at a page that would 403.
 * The lock itself is real and worth saying; the cause and the CTA are not.
 */
function TenantBanners({
  tenantStatus,
  mayReadBilling,
  isGracePeriod,
  graceDays,
}: {
  tenantStatus: string | undefined;
  mayReadBilling: boolean;
  isGracePeriod: boolean;
  graceDays: number | null;
}) {
  if (tenantStatus === 'write-locked') {
    if (!mayReadBilling) {
      return (
        <Banner variant="warning">
          Uploads are disabled for this organization — contact an organization owner.
        </Banner>
      );
    }
    return (
      <Banner variant="warning" action={{ label: 'Upgrade', href: '/billing' }}>
        {isGracePeriod
          ? gracePeriodMessage(graceDays)
          : 'Storage limit exceeded. Uploads are disabled. Delete files or upgrade to resume.'}
      </Banner>
    );
  }

  if (tenantStatus === 'disabled') {
    if (!mayReadBilling) {
      return (
        <Banner variant="error">
          This organization&rsquo;s account is disabled — contact an organization owner.
        </Banner>
      );
    }
    return (
      <Banner variant="error" action={{ label: 'Manage account', href: '/billing' }}>
        Account disabled. Visit billing to restore access.
      </Banner>
    );
  }

  return null;
}

type AppShellProps = {
  children: React.ReactNode;
  /** Forwarded to `SidebarNav` on both the desktop and mobile-drawer copies. */
  hideNavLinks?: boolean;
};

// Grace-period banner copy. `daysUntil` compares calendar days and clamps to
// >= 0, so 0 means the account is disabled later today; null means we have no
// deadline to count down to. Only upgrading preserves access, so the copy never
// implies that downloading data does.
export function gracePeriodMessage(graceDays: number | null): string {
  if (graceDays === null) {
    return "Your free trial has expired. Upgrade to keep access, or download your data before it's removed.";
  }
  if (graceDays === 0) {
    return "Your free trial has expired, and your account will be disabled later today. Upgrade to keep access or download your data before it's removed.";
  }
  return `Your free trial has expired. ${pluralizeDays(graceDays)} left to upgrade or download your data.`;
}

export function AppShell({ children, hideNavLinks = false }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const hamburgerButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerId = useId();

  const mayReadBilling = useHasPermission('billing.view');

  const { data: usage } = useQuery({
    queryKey: queryKeys.usage,
    queryFn: getUsage,
    staleTime: USAGE_STALE_TIME,
  });
  const { data: billing } = useQuery({
    queryKey: queryKeys.billing,
    queryFn: getBilling,
    enabled: mayReadBilling,
  });

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
    // The console's own default background: zinc-50 everywhere, so anything
    // not explicitly given a different color (the sidebar and the frame
    // around the content window, both bg-white below) reads as the same
    // soft grey as the content window itself, whatever gets revealed by a
    // short page, a resize, or a scroll bounce overshooting its bounds.
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-50">
      <TenantBanners
        tenantStatus={tenantStatus}
        mayReadBilling={mayReadBilling}
        isGracePeriod={isGracePeriod}
        graceDays={graceDays}
      />
      <div className="flex flex-1 overflow-hidden bg-white">
        {/* Desktop sidebar — unchanged */}
        <div
          className={`hidden flex-shrink-0 transition-all duration-200 lg:block ${collapsed ? 'w-20' : 'w-60'}`}
        >
          <SidebarNav collapsed={collapsed} showTestIds={true} hideNavLinks={hideNavLinks} />
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
              id="mobile-nav-close-button"
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
              onClose={closeDrawer}
              showUserProfile={false}
              showTestIds={false}
              hideNavLinks={hideNavLinks}
            />
          </div>
        </div>

        {/* On desktop the content sits in an inset "window": a rounded, bordered,
            softly shadowed panel floating on the white canvas, with the sidebar
            outside it (Linear's layout). The `lg:` insets and card chrome are
            desktop-only; on mobile the content stays edge to edge. The panel is
            the scroll container, so its rounded corners clip the content.
            `main` itself stays transparent: on mobile it sits directly on the
            grey root with nothing to override, and on desktop its `lg:`
            padding sits inside the white frame above, so either way it already
            shows the right color without needing its own. */}
        <main className="flex flex-1 flex-col overflow-hidden lg:px-2 lg:pt-2">
          {/* `overscroll-contain`: a fast fling can overshoot the panel's own
              scroll bounds and chain onto the document's scroll, which
              briefly reveals `<body>`'s background (unset, so browser-default
              white) instead of anything this app styles. Containing the
              overscroll here keeps the bounce inside the panel, where its own
              background already matches. */}
          <div className="flex flex-1 flex-col overflow-auto overscroll-contain bg-zinc-50 lg:rounded-xl lg:border lg:border-zinc-200 lg:shadow-xs">
            {/* Mobile top bar */}
            <div className="sticky top-0 z-20 flex h-14 flex-shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-3 lg:hidden">
              <MobileUserMenu />
              <button
                ref={hamburgerButtonRef}
                id="mobile-nav-toggle-button"
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
          </div>

          {/* Utility bar under the content window (desktop only): quiet controls
              that belong to the app rather than the page. The sidebar collapse
              toggle sits at the left since it acts on the sidebar beside it;
              bug report and system status stay grouped at the right the way
              Linear places them. h-12 (not h-10) matches the sidebar footer's
              total height (p-2 around a py-1.5 button = 48px) so both bars,
              bottom-anchored side by side, land on the same vertical center. */}
          <div className="hidden h-12 flex-shrink-0 items-center justify-between gap-1 px-1 lg:flex">
            <Tooltip content={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} side="right">
              <button
                type="button"
                onClick={() => setCollapsed((c) => !c)}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
              >
                <SidebarSimpleIcon size={18} />
              </button>
            </Tooltip>
            <div className="flex items-center gap-1">
              <ReportBugButton />
              <SystemStatusPill />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
