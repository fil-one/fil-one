import { useRef, useState } from 'react';
import {
  SquaresFourIcon,
  DatabaseIcon,
  KeyIcon,
  CreditCardIcon,
  GearIcon,
  CaretLeftIcon,
  CaretRightIcon,
  BookOpenIcon,
  ChatCircleIcon,
  SignOutIcon,
  QuestionIcon,
} from '@phosphor-icons/react/dist/ssr';
import { useQuery } from '@tanstack/react-query';
import { Link, useMatchRoute } from '@tanstack/react-router';

import { DOCS_URL, SubscriptionStatus, getUsageLimits, formatBytes } from '@filone/shared';
import { getBilling, getMe, getUsage, logout } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';
import { daysUntil, formatDateTime } from '../lib/time.js';

import { Button } from './Button.js';
import { ProgressBar } from './ProgressBar.js';
import { StatusIndicator } from './StatusIndicator.js';
import { Tooltip } from './Tooltip.js';

type SidebarNavProps = {
  collapsed: boolean;
  onToggle: () => void;
};

type NavItem = {
  path: string;
  icon: React.ElementType;
  label: string;
};

const navItems: NavItem[] = [
  { path: '/dashboard', icon: SquaresFourIcon, label: 'Dashboard' },
  { path: '/buckets', icon: DatabaseIcon, label: 'Buckets' },
  { path: '/api-keys', icon: KeyIcon, label: 'API Keys' },
  { path: '/billing', icon: CreditCardIcon, label: 'Billing' },
  { path: '/settings', icon: GearIcon, label: 'Settings' },
];

type NavLinksProps = {
  collapsed: boolean;
  matchRoute: ReturnType<typeof useMatchRoute>;
};

function NavLinks({ collapsed, matchRoute }: NavLinksProps) {
  return (
    <div className="flex flex-col gap-0.5 p-2">
      {navItems.map(({ path, icon: Icon, label }) => {
        const isActive = Boolean(matchRoute({ to: path, fuzzy: path === '/buckets' }));
        const link = (
          <Link
            key={path}
            to={path}
            aria-label={label}
            className={[
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
              collapsed ? 'justify-center' : '',
              isActive ? 'bg-brand-50 text-brand-700' : 'text-zinc-600 hover:bg-zinc-100',
            ]
              .filter(Boolean)
              .join(' ')}
            activeProps={{ className: 'bg-brand-50 text-brand-700' }}
          >
            <Icon size={18} className={`flex-shrink-0 ${isActive ? '' : 'text-zinc-400'}`} />
            {!collapsed && <span>{label}</span>}
          </Link>
        );
        if (collapsed) {
          return (
            <Tooltip key={path} content={label} side="right">
              {link}
            </Tooltip>
          );
        }
        return link;
      })}
    </div>
  );
}

type StatusBannersProps = {
  collapsed: boolean;
  isTrialing: boolean;
  trialDays: number | null;
  trialEndsLabel: string | undefined;
  storageUsed: number;
  storagePct: number;
  egressUsed: number;
  egressPct: number;
  isGracePeriod: boolean;
  isTrialExpiredGrace: boolean;
  graceDays: number | null;
  graceEndsLabel: string | undefined;
  isPastDue: boolean;
  isCanceled: boolean;
};

function StatusBanners({
  collapsed,
  isTrialing,
  trialDays,
  trialEndsLabel,
  storageUsed,
  storagePct,
  egressUsed,
  egressPct,
  isGracePeriod,
  isTrialExpiredGrace,
  graceDays,
  graceEndsLabel,
  isPastDue,
  isCanceled,
}: StatusBannersProps) {
  return (
    <>
      {!collapsed && isTrialing && (
        <div className="border-t border-zinc-200 px-3 py-4">
          <p className="text-xs font-medium text-zinc-900" title={trialEndsLabel}>
            {trialDays !== null ? `${trialDays} days left in trial` : 'Trial active'}
          </p>
          <div className="mt-2.5 space-y-2.5">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-zinc-500">Storage</span>
                <span className="text-zinc-700">{formatBytes(storageUsed)} / 1 TB</span>
              </div>
              <ProgressBar value={storagePct} size="sm" label="Storage usage" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-zinc-500">Egress</span>
                <span className="text-zinc-700">{formatBytes(egressUsed)} / 2 TB</span>
              </div>
              <ProgressBar value={egressPct} size="sm" label="Egress usage" />
            </div>
          </div>
          <div className="mt-3">
            <Button variant="primary" href="/billing" className="w-full justify-center text-xs">
              Upgrade
            </Button>
          </div>
        </div>
      )}
      {!collapsed && isGracePeriod && isTrialExpiredGrace && (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-4">
          <p className="text-xs font-medium text-amber-800" title={graceEndsLabel}>
            Your free trial has expired.{graceDays !== null ? ` ${graceDays} days left` : ''} to
            upgrade or download your data.
          </p>
          <div className="mt-3">
            <Button variant="primary" href="/billing" className="w-full justify-center text-xs">
              Upgrade
            </Button>
          </div>
        </div>
      )}
      {!collapsed && isGracePeriod && !isTrialExpiredGrace && (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-4">
          <p className="text-xs font-medium text-amber-800" title={graceEndsLabel}>
            Subscription canceled.{graceDays !== null ? ` ${graceDays} days left` : ''} to
            reactivate or download your data.
          </p>
          <div className="mt-3">
            <Button variant="primary" href="/billing" className="w-full justify-center text-xs">
              Reactivate
            </Button>
          </div>
        </div>
      )}
      {!collapsed && isPastDue && (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-4">
          <p className="text-xs font-medium text-amber-800" title={graceEndsLabel}>
            Payment failed. Update your payment method to avoid losing access.
            {graceDays !== null ? ` ${graceDays} days remaining.` : ''}
          </p>
          <div className="mt-3">
            <Button variant="primary" href="/billing" className="w-full justify-center text-xs">
              Update payment
            </Button>
          </div>
        </div>
      )}
      {!collapsed && isCanceled && (
        <div className="border-t border-red-200 bg-red-50 px-3 py-4">
          <p className="text-xs font-medium text-red-800">
            Account canceled. Reactivate to regain access.
          </p>
          <div className="mt-3">
            <Button variant="primary" href="/billing" className="w-full justify-center text-xs">
              Reactivate
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

export type HelpMenuProps = {
  collapsed: boolean;
  helpMenuOpen: boolean;
  helpMenuRef: React.RefObject<HTMLDivElement | null>;
  helpButtonRef: React.RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
};

export function HelpMenu({
  collapsed,
  helpMenuOpen,
  helpMenuRef,
  helpButtonRef,
  onToggle,
}: HelpMenuProps) {
  return (
    <div className="relative border-t border-zinc-200 p-2">
      {collapsed ? (
        <Tooltip content="Help" side="right">
          <button
            ref={helpButtonRef}
            type="button"
            onClick={onToggle}
            aria-label="Help"
            className="flex w-full items-center justify-center rounded-lg px-3 py-2 text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            <QuestionIcon size={18} className="text-zinc-400" />
          </button>
        </Tooltip>
      ) : (
        <button
          ref={helpButtonRef}
          type="button"
          onClick={onToggle}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
        >
          <QuestionIcon size={18} className="flex-shrink-0 text-zinc-400" />
          Help
        </button>
      )}
      {helpMenuOpen && (
        <div
          ref={helpMenuRef}
          className="absolute bottom-full left-2 z-50 mb-1 w-52 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg"
        >
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            <BookOpenIcon size={18} className="flex-shrink-0 text-zinc-400" />
            Documentation
          </a>
          <Link
            to="/support"
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
          >
            <ChatCircleIcon size={18} className="flex-shrink-0 text-zinc-400" />
            Talk to an expert
          </Link>
        </div>
      )}
    </div>
  );
}

export function SidebarNav({ collapsed, onToggle }: SidebarNavProps) {
  const matchRoute = useMatchRoute();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userButtonRef = useRef<HTMLButtonElement>(null);
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const helpMenuRef = useRef<HTMLDivElement>(null);
  const helpButtonRef = useRef<HTMLButtonElement>(null);

  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: () => getMe() });
  const { data: billing } = useQuery({ queryKey: queryKeys.billing, queryFn: getBilling });
  const { data: usage } = useQuery({ queryKey: queryKeys.usage, queryFn: getUsage });

  const displayName = me?.name || me?.email || 'User';
  const initial = displayName.charAt(0).toUpperCase();

  const isTrialing = billing?.subscription.status === SubscriptionStatus.Trialing;
  const isGracePeriod = billing?.subscription.status === SubscriptionStatus.GracePeriod;
  const isPastDue = billing?.subscription.status === SubscriptionStatus.PastDue;
  const isCanceled = billing?.subscription.status === SubscriptionStatus.Canceled;
  const trialDays =
    isTrialing && billing?.subscription.trialEndsAt
      ? daysUntil(billing.subscription.trialEndsAt)
      : null;
  const trialEndsLabel = billing?.subscription.trialEndsAt
    ? `Expires ${formatDateTime(billing.subscription.trialEndsAt)}`
    : undefined;
  const graceDays = billing?.subscription.gracePeriodEndsAt
    ? daysUntil(billing.subscription.gracePeriodEndsAt)
    : null;
  const graceEndsLabel = billing?.subscription.gracePeriodEndsAt
    ? `Expires ${formatDateTime(billing.subscription.gracePeriodEndsAt)}`
    : undefined;
  const isTrialExpiredGrace = isGracePeriod && !!billing?.subscription.trialEndsAt;

  const isActivePaid = billing?.subscription.status === SubscriptionStatus.Active;
  const limits = getUsageLimits(!!isActivePaid);
  const storageUsed = usage?.storage.usedBytes ?? 0;
  const storagePct =
    limits.storageLimitBytes > 0
      ? Math.min(100, (storageUsed / limits.storageLimitBytes) * 100)
      : 0;
  const egressUsed = usage?.egress.usedBytes ?? 0;
  const egressPct =
    limits.egressLimitBytes > 0 ? Math.min(100, (egressUsed / limits.egressLimitBytes) * 100) : 0;

  function handleClickOutside(e: React.MouseEvent) {
    if (
      userMenuRef.current &&
      !userMenuRef.current.contains(e.target as Node) &&
      userButtonRef.current &&
      !userButtonRef.current.contains(e.target as Node)
    ) {
      setUserMenuOpen(false);
    }
    if (
      helpMenuRef.current &&
      !helpMenuRef.current.contains(e.target as Node) &&
      helpButtonRef.current &&
      !helpButtonRef.current.contains(e.target as Node)
    ) {
      setHelpMenuOpen(false);
    }
  }

  return (
    <div className="h-full" onClick={handleClickOutside}>
      <nav className="relative flex h-full flex-col border-r border-zinc-200 bg-white">
        {/* Expand toggle (collapsed) — centered on the sidebar's right border */}
        {collapsed && (
          <div className="absolute -right-3 top-7 z-10 -translate-y-1/2">
            <Tooltip content="Expand sidebar" side="right">
              <button
                type="button"
                onClick={onToggle}
                aria-label="Expand sidebar"
                className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-400 shadow-sm hover:text-zinc-600"
              >
                <CaretRightIcon size={14} />
              </button>
            </Tooltip>
          </div>
        )}

        {/* User profile + collapse toggle */}
        <div className="relative flex h-14 flex-shrink-0 items-center px-2">
          <button
            ref={userButtonRef}
            type="button"
            data-testid="user-profile"
            onClick={() => setUserMenuOpen((o) => !o)}
            className={[
              'flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-zinc-100',
              collapsed ? 'w-full justify-center' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
              {initial}
            </span>
            {!collapsed && (
              <div className="min-w-0 overflow-hidden text-left">
                <p className="truncate text-sm font-medium leading-tight text-zinc-900">
                  {displayName}
                </p>
                {me?.orgName && (
                  <p className="truncate text-xs leading-tight text-zinc-500">{me.orgName}</p>
                )}
              </div>
            )}
          </button>

          {/* Spacer + collapse toggle (expanded only) */}
          {!collapsed && (
            <>
              <div className="flex-1" />
              <Tooltip content="Collapse sidebar" side="right">
                <button
                  type="button"
                  onClick={onToggle}
                  aria-label="Collapse sidebar"
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
                >
                  <CaretLeftIcon size={16} />
                </button>
              </Tooltip>
            </>
          )}

          {/* User dropdown */}
          {userMenuOpen && (
            <div
              ref={userMenuRef}
              className="absolute left-2 top-14 z-50 w-52 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg"
            >
              <button
                type="button"
                onClick={logout}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100"
              >
                <SignOutIcon size={18} className="flex-shrink-0 text-zinc-400" />
                Log out
              </button>
            </div>
          )}
        </div>

        {/* Primary nav items */}
        <NavLinks collapsed={collapsed} matchRoute={matchRoute} />

        {/* Spacer */}
        <div className="flex-1" />

        {/* Status banners */}
        <StatusBanners
          collapsed={collapsed}
          isTrialing={isTrialing}
          trialDays={trialDays}
          trialEndsLabel={trialEndsLabel}
          storageUsed={storageUsed}
          storagePct={storagePct}
          egressUsed={egressUsed}
          egressPct={egressPct}
          isGracePeriod={isGracePeriod}
          isTrialExpiredGrace={isTrialExpiredGrace}
          graceDays={graceDays}
          graceEndsLabel={graceEndsLabel}
          isPastDue={isPastDue}
          isCanceled={isCanceled}
        />

        {/* Help button */}
        <HelpMenu
          collapsed={collapsed}
          helpMenuOpen={helpMenuOpen}
          helpMenuRef={helpMenuRef}
          helpButtonRef={helpButtonRef}
          onToggle={() => setHelpMenuOpen((o) => !o)}
        />

        {/* System status */}
        <StatusIndicator collapsed={collapsed} />
      </nav>
    </div>
  );
}
