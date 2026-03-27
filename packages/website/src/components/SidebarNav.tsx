import { useEffect, useRef, useState } from 'react';
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
} from '@phosphor-icons/react/dist/ssr';
import { Link, useMatchRoute } from '@tanstack/react-router';
import { ProgressBar } from './ProgressBar';
import { Button } from './Button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './Tooltip';
import { SubscriptionStatus, getUsageLimits, formatBytes } from '@filone/shared';
import type { BillingInfo, MeResponse, UsageResponse } from '@filone/shared';
import { getBilling, getMe, getUsage, logout } from '../lib/api.js';
import { daysUntil, formatDateTime } from '../lib/time.js';

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
  { path: '/api-keys', icon: KeyIcon, label: 'API & Keys' },
  { path: '/billing', icon: CreditCardIcon, label: 'Billing' },
  { path: '/settings', icon: GearIcon, label: 'Settings' },
];

export function SidebarNav({ collapsed, onToggle }: SidebarNavProps) {
  const matchRoute = useMatchRoute();
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!userMenuOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(e.target as Node) &&
        userButtonRef.current &&
        !userButtonRef.current.contains(e.target as Node)
      ) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [userMenuOpen]);

  useEffect(() => {
    const refresh = () => {
      getBilling()
        .then(setBilling)
        .catch(() => {
          /* silent */
        });
      getUsage()
        .then(setUsage)
        .catch(() => {
          /* silent */
        });
    };
    refresh();
    window.addEventListener('billing:updated', refresh);
    return () => window.removeEventListener('billing:updated', refresh);
  }, []);

  useEffect(() => {
    getMe()
      .then(setMe)
      .catch(() => {
        /* silent */
      });
  }, []);

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

  return (
    <TooltipProvider delayDuration={0}>
      <nav className="flex h-full flex-col border-r border-zinc-200 bg-white">
        {/* User + collapse toggle */}
        <div
          className={`relative flex h-14 flex-shrink-0 items-center px-2 ${collapsed ? 'justify-center' : 'gap-1'}`}
        >
          <button
            ref={userButtonRef}
            type="button"
            onClick={() => setUserMenuOpen((o) => !o)}
            className={`flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-zinc-100 ${collapsed ? '' : 'flex-1'}`}
          >
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
              {initial}
            </span>
            {!collapsed && (
              <div className="min-w-0 text-left overflow-hidden">
                <p className="truncate text-sm font-medium text-zinc-900 leading-tight">
                  {displayName}
                </p>
                {me?.orgName && (
                  <p className="truncate text-xs text-zinc-500 leading-tight">{me.orgName}</p>
                )}
              </div>
            )}
          </button>

          {/* User dropdown */}
          {userMenuOpen && (
            <div
              ref={userMenuRef}
              className="absolute left-2 top-14 z-50 w-52 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg"
            >
              <Link
                to="/support"
                onClick={() => setUserMenuOpen(false)}
                className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100"
              >
                <ChatCircleIcon size={18} className="flex-shrink-0 text-zinc-400" />
                Talk to an expert
              </Link>
              <button
                type="button"
                onClick={logout}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100"
              >
                <SignOutIcon size={18} className="flex-shrink-0 text-zinc-400" />
                Log out
              </button>
            </div>
          )}

          {/* Collapse toggle */}
          {!collapsed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onToggle}
                  aria-label="Collapse sidebar"
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
                >
                  <CaretLeftIcon size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Collapse sidebar</TooltipContent>
            </Tooltip>
          )}

          {/* Collapsed expand button — floats outside sidebar */}
          {collapsed && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onToggle}
                  aria-label="Expand sidebar"
                  className="absolute -right-3 top-4 flex h-6 w-6 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-400 shadow-sm hover:text-zinc-600"
                >
                  <CaretRightIcon size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Expand sidebar</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Primary nav items */}
        <div className="flex flex-col gap-0.5 p-2">
          {navItems.map(({ path, icon: Icon, label }) => {
            const isActive = Boolean(matchRoute({ to: path, fuzzy: path === '/buckets' }));

            const link = (
              <Link
                key={path}
                to={path}
                className={[
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
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
                <Tooltip key={path}>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right">{label}</TooltipContent>
                </Tooltip>
              );
            }

            return link;
          })}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Trial section (expanded only) — only shown for trialing users */}
        {!collapsed && isTrialing && (
          <div className="border-t border-zinc-200 px-3 py-4">
            <p className="text-xs font-medium text-zinc-900" title={trialEndsLabel}>
              {trialDays !== null ? `${trialDays} days left in trial` : 'Trial active'}
            </p>
            <div className="mt-2.5 space-y-2.5">
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px]">
                  <span className="text-zinc-500">Storage</span>
                  <span className="text-zinc-700">{formatBytes(storageUsed)} / 1 TB</span>
                </div>
                <ProgressBar value={storagePct} size="sm" label="Storage usage" />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px]">
                  <span className="text-zinc-500">Egress</span>
                  <span className="text-zinc-700">{formatBytes(egressUsed)} / 2 TB</span>
                </div>
                <ProgressBar value={egressPct} size="sm" label="Egress usage" />
              </div>
            </div>
            <div className="mt-3">
              <Button variant="default" asChild className="w-full justify-center text-xs">
                <Link to="/billing">Upgrade</Link>
              </Button>
            </div>
          </div>
        )}

        {/* Grace period banner (trial expired) */}
        {!collapsed && isGracePeriod && isTrialExpiredGrace && (
          <div className="border-t border-amber-200 bg-amber-50 px-3 py-4">
            <p className="text-xs font-medium text-amber-800" title={graceEndsLabel}>
              Your free trial has expired.{graceDays !== null ? ` ${graceDays} days left` : ''} to
              upgrade or download your data.
            </p>
            <div className="mt-3">
              <Button variant="default" asChild className="w-full justify-center text-xs">
                <Link to="/billing">Upgrade</Link>
              </Button>
            </div>
          </div>
        )}

        {/* Grace period banner (subscription canceled) */}
        {!collapsed && isGracePeriod && !isTrialExpiredGrace && (
          <div className="border-t border-amber-200 bg-amber-50 px-3 py-4">
            <p className="text-xs font-medium text-amber-800" title={graceEndsLabel}>
              Subscription canceled.{graceDays !== null ? ` ${graceDays} days left` : ''} to
              reactivate or download your data.
            </p>
            <div className="mt-3">
              <Button variant="default" asChild className="w-full justify-center text-xs">
                <Link to="/billing">Reactivate</Link>
              </Button>
            </div>
          </div>
        )}

        {/* Past due banner */}
        {!collapsed && isPastDue && (
          <div className="border-t border-amber-200 bg-amber-50 px-3 py-4">
            <p className="text-xs font-medium text-amber-800" title={graceEndsLabel}>
              Payment failed. Update your payment method to avoid losing access.
              {graceDays !== null ? ` ${graceDays} days remaining.` : ''}
            </p>
            <div className="mt-3">
              <Button variant="default" asChild className="w-full justify-center text-xs">
                <Link to="/billing">Update payment</Link>
              </Button>
            </div>
          </div>
        )}

        {/* Canceled banner */}
        {!collapsed && isCanceled && (
          <div className="border-t border-red-200 bg-red-50 px-3 py-4">
            <p className="text-xs font-medium text-red-800">
              Account canceled. Reactivate to regain access.
            </p>
            <div className="mt-3">
              <Button variant="default" asChild className="w-full justify-center text-xs">
                <Link to="/billing">Reactivate</Link>
              </Button>
            </div>
          </div>
        )}

        {/* Bottom links */}
        <div className="flex flex-col gap-0.5 border-t border-zinc-200 p-2">
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href="#"
                  className="flex items-center justify-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <BookOpenIcon size={18} className="flex-shrink-0 text-zinc-400" />
                </a>
              </TooltipTrigger>
              <TooltipContent side="right">Documentation</TooltipContent>
            </Tooltip>
          ) : (
            <a
              href="#"
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100"
              target="_blank"
              rel="noopener noreferrer"
            >
              <BookOpenIcon size={18} className="flex-shrink-0 text-zinc-400" />
              <span>Documentation</span>
            </a>
          )}
        </div>
      </nav>
    </TooltipProvider>
  );
}
