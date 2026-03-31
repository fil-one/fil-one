import { useEffect, useState } from 'react';
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
} from '@phosphor-icons/react/dist/ssr';
import { Link, useMatchRoute } from '@tanstack/react-router';
import { ProgressBar } from './ProgressBar.js';
import { Button } from './Button.js';
import { DOCS_URL, SubscriptionStatus, getUsageLimits, formatBytes } from '@filone/shared';
import type { BillingInfo, UsageResponse } from '@filone/shared';
import { getBilling, getUsage } from '../lib/api.js';
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
    <nav className="flex h-full flex-col border-r border-zinc-200 bg-white">
      {/* Logo + collapse toggle */}
      <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-zinc-200 px-3">
        <div className="flex items-center overflow-hidden">
          <img src="/fil-one-logo.svg" alt="Fil.one" className={collapsed ? 'h-7 w-7' : 'h-7'} />
        </div>

        {/* Collapse toggle */}
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
        >
          {collapsed ? <CaretRightIcon size={16} /> : <CaretLeftIcon size={16} />}
        </button>
      </div>

      {/* Primary nav items */}
      <div className="flex flex-col gap-0.5 p-2">
        {navItems.map(({ path, icon: Icon, label }) => {
          const isActive = Boolean(matchRoute({ to: path, fuzzy: path === '/buckets' }));

          return (
            <Link
              key={path}
              to={path}
              title={collapsed ? label : undefined}
              className={[
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                collapsed ? 'justify-center' : '',
                isActive ? 'bg-brand-50 text-brand-700' : 'text-zinc-600 hover:bg-zinc-100',
              ]
                .filter(Boolean)
                .join(' ')}
              activeProps={{ className: 'bg-brand-50 text-brand-700' }}
            >
              <Icon size={18} className="flex-shrink-0" />
              {!collapsed && <span>{label}</span>}
            </Link>
          );
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
            <Button variant="filled" href="/billing" className="w-full justify-center text-xs">
              Upgrade
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
            <Button variant="filled" href="/billing" className="w-full justify-center text-xs">
              Upgrade
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
            <Button variant="filled" href="/billing" className="w-full justify-center text-xs">
              Reactivate
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
            <Button variant="filled" href="/billing" className="w-full justify-center text-xs">
              Update payment
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
            <Button variant="filled" href="/billing" className="w-full justify-center text-xs">
              Reactivate
            </Button>
          </div>
        </div>
      )}

      {/* Bottom links */}
      <div className="flex flex-col gap-0.5 border-t border-zinc-200 p-2">
        <a
          href={DOCS_URL}
          title={collapsed ? 'Documentation' : undefined}
          className={[
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100',
            collapsed ? 'justify-center' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          target="_blank"
          rel="noopener noreferrer"
        >
          <BookOpenIcon size={18} className="flex-shrink-0" />
          {!collapsed && <span>Documentation</span>}
        </a>

        <Link
          to="/support"
          title={collapsed ? 'Talk to an expert' : undefined}
          className={[
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100',
            collapsed ? 'justify-center' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <ChatCircleIcon size={18} className="flex-shrink-0" />
          {!collapsed && <span>Talk to an expert</span>}
        </Link>
      </div>
    </nav>
  );
}
