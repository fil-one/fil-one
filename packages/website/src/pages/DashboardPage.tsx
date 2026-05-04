import { lazy, Suspense, useState } from 'react';
import {
  PlusIcon,
  DatabaseIcon,
  KeyIcon,
  ArrowUpIcon,
  XIcon,
} from '@phosphor-icons/react/dist/ssr';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

const UsageTrends = lazy(() => import('./UsageTrends'));

import { Heading } from '../components/Heading/Heading';
import { Button } from '../components/Button';
import { ProgressBar } from '../components/ProgressBar';
import { formatBytes } from '@filone/shared';

import { PlanId, SubscriptionStatus, TB_BYTES, getUsageLimits } from '@filone/shared';
import type { RecentActivity } from '@filone/shared';

import { getUsage, getBilling, getActivity } from '../lib/api.js';
import { daysUntil, formatDateTime, timeAgo } from '../lib/time.js';
import { queryKeys } from '../lib/query-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function planDisplayName(planId: PlanId): string {
  switch (planId) {
    case PlanId.FreeTrial:
      return 'Free trial';
    case PlanId.PayAsYouGo:
      return 'Pay As You Go';
    default:
      return 'Unknown';
  }
}

function statusBadge(status: SubscriptionStatus): { label: string; className: string } {
  switch (status) {
    case SubscriptionStatus.Trialing:
      return {
        label: 'Trial',
        className: 'bg-[rgba(0,128,255,0.1)] text-[#0080ff]',
      };
    case SubscriptionStatus.Active:
      return {
        label: 'Active',
        className: 'bg-green-50 text-green-600',
      };
    case SubscriptionStatus.PastDue:
      return {
        label: 'Past Due',
        className: 'bg-amber-50 text-amber-600',
      };
    case SubscriptionStatus.Canceled:
      return {
        label: 'Canceled',
        className: 'bg-red-50 text-red-600',
      };
    case SubscriptionStatus.GracePeriod:
      return {
        label: 'Grace Period',
        className: 'bg-amber-50 text-amber-600',
      };
    default:
      return { label: status, className: 'bg-zinc-100 text-zinc-500' };
  }
}

function estimateMonthlyCost(usedBytes: number, pricePerTbCents: number): string {
  if (usedBytes === 0) return '$0.00';
  const tb = usedBytes / TB_BYTES;
  const cents = tb * pricePerTbCents;
  return `$${(cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function DashboardSkeleton() {
  return (
    <div className="p-6 animate-pulse">
      <div className="mb-6 h-8 w-40 rounded bg-zinc-200" />
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="h-[157px] rounded-xl bg-zinc-100" />
        <div className="h-[157px] rounded-xl bg-zinc-100" />
        <div className="h-[157px] rounded-xl bg-zinc-100" />
      </div>
      <div className="mb-5 h-[88px] rounded-xl bg-zinc-100" />
      <div className="h-48 rounded-lg bg-zinc-100" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// eslint-disable-next-line max-lines-per-function, complexity/complexity
export function DashboardPage() {
  const [trialBannerVisible, setTrialBannerVisible] = useState(true);

  const { data: usage, isPending: usagePending } = useQuery({
    queryKey: queryKeys.usage,
    queryFn: getUsage,
  });

  const { data: billing, isPending: billingPending } = useQuery({
    queryKey: queryKeys.billing,
    queryFn: getBilling,
  });

  // Activity is optional — silently ignored if it fails
  const { data: activityData } = useQuery({
    queryKey: queryKeys.activityRecent(5),
    queryFn: () => getActivity({ limit: 5 }),
  });
  const activities: RecentActivity[] = activityData?.activities ?? [];

  if (usagePending || billingPending || !usage || !billing) {
    return <DashboardSkeleton />;
  }

  const isTrialing = billing.subscription.status === SubscriptionStatus.Trialing;
  const isActivePaid = billing.subscription.status === SubscriptionStatus.Active;
  const trialDaysLeft =
    isTrialing && billing.subscription.trialEndsAt
      ? daysUntil(billing.subscription.trialEndsAt)
      : null;
  const trialEndsLabel = billing.subscription.trialEndsAt
    ? `Expires ${formatDateTime(billing.subscription.trialEndsAt)}`
    : undefined;

  const showQuickSetup =
    usage.buckets.count === 0 || usage.objects.count === 0 || usage.accessKeys.count === 0;

  const badge = statusBadge(billing.subscription.status);
  const pricePerTbCents = billing.subscription.planId === PlanId.PayAsYouGo ? 499 : 0;

  const limits = getUsageLimits(isActivePaid);
  const storagePct =
    limits.storageLimitBytes > 0
      ? Math.round((usage.storage.usedBytes / limits.storageLimitBytes) * 100)
      : 0;

  const egressPct =
    limits.egressLimitBytes > 0
      ? Math.round((usage.egress.usedBytes / limits.egressLimitBytes) * 100)
      : 0;

  const quickSetupTasks = [
    {
      id: 'create-bucket',
      icon: DatabaseIcon,
      title: 'Create a bucket',
      subtitle: 'Organize your storage',
      href: '/buckets',
      done: usage.buckets.count > 0,
    },
    {
      id: 'upload-object',
      icon: ArrowUpIcon,
      title: 'Upload an object',
      subtitle: 'Store files on Filecoin',
      href: '/buckets',
      done: usage.objects.count > 0,
    },
    {
      id: 'generate-key',
      icon: KeyIcon,
      title: 'Generate API key',
      subtitle: 'Connect via S3 API',
      href: '/api-keys',
      done: usage.accessKeys.count > 0,
    },
  ];

  const quickSetupDone = quickSetupTasks.filter((t) => t.done).length;
  const quickSetupTotal = quickSetupTasks.length;

  return (
    <div className="p-6">
      {/* 1. Page header */}
      <div className="mb-5 flex items-center justify-between">
        <Heading tag="h1" size="xl">
          Dashboard
        </Heading>
        <Link
          to="/buckets"
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)] hover:bg-zinc-50"
        >
          <PlusIcon size={16} />
          New bucket
        </Link>
      </div>

      {/* 2. Trial banner */}
      {isTrialing && trialBannerVisible && (
        <div className="mb-5 flex items-center justify-between rounded-xl bg-[rgba(0,128,255,0.06)] px-5 py-3.5 shadow-[0px_0px_0px_1px_rgba(0,128,255,0.1)]">
          <div className="flex items-center gap-4">
            <span
              title={trialEndsLabel}
              className="rounded-full bg-[rgba(0,128,255,0.15)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#0080ff]"
            >
              {trialDaysLeft !== null ? `${trialDaysLeft} days left` : 'TRIAL'}
            </span>
            <p className="text-[13px]">
              <span className="font-medium text-zinc-900">Free trial</span>
              <span className="text-[#677183]">
                {' '}
                — Add a payment method to unlock unlimited storage at $4.99/TB
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/billing"
              className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-br from-[#0080ff] to-[#256af4] px-3 py-1.5 text-xs font-medium text-white shadow-[0px_1px_2px_0px_rgba(0,0,0,0.05)] hover:opacity-90"
            >
              Upgrade
              <span aria-hidden="true">→</span>
            </Link>
            <button
              type="button"
              aria-label="Dismiss trial banner"
              onClick={() => setTrialBannerVisible(false)}
              className="rounded-md p-1.5 text-zinc-400 hover:text-zinc-600"
            >
              <XIcon size={16} />
            </button>
          </div>
        </div>
      )}

      {/* 3. Quick Setup */}
      {showQuickSetup && (
        <div className="mb-5 rounded-xl border border-[#e1e4ea] bg-white p-5 shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)]">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#677183]">
              QUICK SETUP
            </span>
            <span className="text-[11px] text-[#677183]">
              {quickSetupDone} of {quickSetupTotal}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {quickSetupTasks.map(({ id, icon: Icon, title, subtitle, href, done }) => (
              <Link
                key={id}
                to={href}
                className={`flex items-center gap-3 rounded-lg border p-4 ${
                  done ? 'border-green-200 bg-green-50' : 'border-[#e1e4ea] hover:bg-zinc-50'
                }`}
              >
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                    done
                      ? 'bg-green-100 text-green-600'
                      : 'bg-[rgba(0,128,255,0.08)] text-[#0080ff]'
                  }`}
                >
                  <Icon size={18} />
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-zinc-900">{title}</p>
                  <p className="text-[11px] text-[#677183]">{subtitle}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* 4. Top row: Plan · Storage · Egress */}
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* Plan card */}
        <div className="flex h-[157px] flex-col justify-between rounded-xl border border-[#e1e4ea] bg-white p-5">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-[#677183]">
                PLAN
              </span>
              {isTrialing && trialDaysLeft !== null && (
                <span
                  title={trialEndsLabel}
                  className="rounded-full bg-[rgba(0,128,255,0.1)] px-2 py-0.5 text-[10px] font-semibold text-[#0080ff]"
                >
                  {trialDaysLeft} days left
                </span>
              )}
              {!isTrialing && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.className}`}
                >
                  {badge.label}
                </span>
              )}
            </div>
            <span className="text-xl font-semibold text-[#14181f]">
              {planDisplayName(billing.subscription.planId)}
            </span>
            {isTrialing && (
              <p className="mt-0.5 text-[11px] text-[#677183]">
                1 TB storage &amp; egress included
              </p>
            )}
            {!isTrialing && (
              <p className="mt-0.5 text-[11px] text-[#677183]">$4.99/TB · no egress fees</p>
            )}
          </div>
          <div>
            {isTrialing ? (
              <Link
                to="/billing"
                className="text-[12px] font-medium text-[#677183] hover:text-zinc-900"
              >
                Upgrade <span aria-hidden="true">→</span>
              </Link>
            ) : (
              <Link
                to="/billing"
                className="text-[12px] font-medium text-[#677183] hover:text-zinc-900"
              >
                Manage plan <span aria-hidden="true">→</span>
              </Link>
            )}
          </div>
        </div>

        {/* Storage card */}
        <div className="flex h-[157px] flex-col justify-between rounded-xl border border-[#e1e4ea] bg-white p-5">
          <div>
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-[#677183]">
              STORAGE
            </span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[30px] font-semibold leading-9 tracking-tight text-[#14181f]">
                {formatBytes(usage.storage.usedBytes)}
              </span>
              {isTrialing && <span className="text-[13px] text-[#677183]">/ 1 TB</span>}
            </div>
          </div>
          {isTrialing ? (
            <ProgressBar value={storagePct} size="sm" label="Storage usage" />
          ) : (
            <div className="flex items-center justify-between border-t border-[#e1e4ea] pt-3">
              <span className="text-[11px] text-[#677183]">Est. monthly cost</span>
              <span className="text-[13px] font-semibold text-[#14181f]">
                {estimateMonthlyCost(usage.storage.usedBytes, pricePerTbCents)}
              </span>
            </div>
          )}
        </div>

        {/* Egress card */}
        <div className="flex h-[157px] flex-col justify-between rounded-xl border border-[#e1e4ea] bg-white p-5">
          <div>
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-[#677183]">
              EGRESS
            </span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[30px] font-semibold leading-9 tracking-tight text-[#14181f]">
                {formatBytes(usage.egress.usedBytes)}
              </span>
              {isTrialing && <span className="text-[13px] text-[#677183]">/ 2 TB</span>}
            </div>
          </div>
          {isTrialing ? (
            <ProgressBar value={egressPct} size="sm" label="Egress usage" />
          ) : (
            <div className="flex items-center border-t border-[#e1e4ea] pt-3">
              <span className="text-[11px] text-[#677183]">No egress fees · unlimited</span>
            </div>
          )}
        </div>
      </div>

      {/* 5. Buckets · Objects · API Keys — single card with vertical dividers */}
      <div className="mb-5 grid grid-cols-3 divide-x divide-[#e1e4ea] rounded-xl border border-[#e1e4ea] bg-white shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)]">
        <div className="px-5 py-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[#677183]">
              BUCKETS
            </span>
            <Link to="/buckets" className="text-[11px] text-[#677183] hover:text-zinc-900">
              View all
            </Link>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-semibold text-[#14181f]">{usage.buckets.count}</span>
            <span className="text-[11px] text-[#677183]">/ {usage.buckets.limit}</span>
          </div>
        </div>
        <div className="px-5 py-4">
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-[#677183]">
            OBJECTS
          </span>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-semibold text-[#14181f]">{usage.objects.count}</span>
            <span className="text-[11px] text-[#677183]">total</span>
          </div>
        </div>
        <div className="px-5 py-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[#677183]">
              API KEYS
            </span>
            <Link to="/api-keys" className="text-[11px] text-[#677183] hover:text-zinc-900">
              View all
            </Link>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-semibold text-[#14181f]">{usage.accessKeys.count}</span>
            <span className="text-[11px] text-[#677183]">/ {usage.accessKeys.limit}</span>
          </div>
        </div>
      </div>

      {/* 6. Filecoin Sealing Status — hidden until event system is ready.
             Re-enable with <SealingStatus /> from ../components/SealingStatus.
             https://linear.app/filecoin-foundation/issue/FIL-77/object-sealing-live-updates-dashboard */}

      {/* 7. Usage Trends */}
      <Suspense fallback={<div className="mb-6" style={{ height: 200 }} />}>
        <UsageTrends />
      </Suspense>

      {/* 8. Recent Activity */}
      <div className="rounded-xl border border-[#e1e4ea] bg-white pb-5 pl-3 pr-5 pt-4 shadow-[0px_1px_2px_0px_rgba(20,24,31,0.03)]">
        <div className="mb-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-[#677183]">
            Recent Activity
          </h2>
        </div>

        {activities.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-sm font-medium text-zinc-700">No activity yet</p>
            <p className="text-sm text-zinc-500">Create a bucket to start storing objects</p>
            <Button variant="primary" icon={PlusIcon} href="/buckets">
              Create bucket
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-zinc-100/50">
            {activities.map((activity) => (
              <div key={activity.id} className="flex items-center gap-4 rounded-lg px-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-zinc-900">
                      {activity.resourceName}
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                        activity.resourceType === 'bucket'
                          ? 'bg-zinc-100 text-[#677183]'
                          : 'bg-purple-50 text-purple-600'
                      }`}
                    >
                      {activity.resourceType}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[#677183]">
                    {activity.action.replace('.', ' ')}
                  </p>
                </div>
                <span className="shrink-0 w-14 text-right text-[11px] text-[#677183]">
                  {timeAgo(activity.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
