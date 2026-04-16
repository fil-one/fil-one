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
import { Link as AppLink } from '../components/Link';

const UsageTrends = lazy(() => import('./UsageTrends'));

import { Heading } from '../components/Heading';
import { Button } from '../components/Button';
import { Badge, type BadgeColor } from '../components/Badge';
import { Card } from '../components/Card';
import { IconBox } from '../components/IconBox';
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

function statusBadge(status: SubscriptionStatus): { label: string; color: BadgeColor } {
  switch (status) {
    case SubscriptionStatus.Trialing:
      return { label: 'Trial', color: 'blue' };
    case SubscriptionStatus.Active:
      return { label: 'Active', color: 'green' };
    case SubscriptionStatus.PastDue:
      return { label: 'Past Due', color: 'amber' };
    case SubscriptionStatus.Canceled:
      return { label: 'Canceled', color: 'red' };
    case SubscriptionStatus.GracePeriod:
      return { label: 'Grace Period', color: 'amber' };
    default:
      return { label: status, color: 'grey' };
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
    <div className="p-8 animate-pulse">
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
    <div className="p-8">
      {/* 1. Page header */}
      <div className="mb-5 flex items-center justify-between">
        <Heading tag="h1">Dashboard</Heading>
        <Button variant="ghost" size="sm" icon={PlusIcon} href="/buckets">
          New bucket
        </Button>
      </div>

      {/* 2. Trial banner */}
      {isTrialing && trialBannerVisible && (
        <div className="mb-5 flex items-center justify-between rounded-xl bg-brand-50 px-5 py-3.5 ring-1 ring-brand-100">
          <div className="flex items-center gap-4">
            <span title={trialEndsLabel}>
              <Badge color="blue" size="sm" weight="medium">
                {trialDaysLeft !== null ? `${trialDaysLeft} days left` : 'TRIAL'}
              </Badge>
            </span>
            <p className="text-[13px]">
              <span className="font-medium text-zinc-900">Free trial</span>
              <span className="text-zinc-500">
                {' '}
                — Add a payment method to unlock unlimited storage at $4.99/TB
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" href="/billing">
              Upgrade →
            </Button>
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
        <Card className="mb-5">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              QUICK SETUP
            </span>
            <span className="text-[11px] text-zinc-500">
              {quickSetupDone} of {quickSetupTotal}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {quickSetupTasks.map(({ id, icon: Icon, title, subtitle, href, done }) => (
              <Link
                key={id}
                to={href}
                className={`flex items-center gap-3 rounded-lg border p-4 ${
                  done ? 'border-green-200 bg-green-50' : 'border-zinc-200 hover:bg-zinc-50'
                }`}
              >
                <IconBox icon={Icon} color={done ? 'green' : 'blue'} size="md" />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-zinc-900">{title}</p>
                  <p className="text-[11px] text-zinc-500">{subtitle}</p>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {/* 4. Top row: Plan · Storage · Egress */}
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* Plan card */}
        <Card className="flex h-[157px] flex-col justify-between">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                PLAN
              </span>
              {isTrialing && trialDaysLeft !== null && (
                <span title={trialEndsLabel}>
                  <Badge color="blue" size="sm" weight="medium">
                    {trialDaysLeft} days left
                  </Badge>
                </span>
              )}
              {!isTrialing && (
                <Badge color={badge.color} size="sm" weight="medium">
                  {badge.label}
                </Badge>
              )}
            </div>
            <span className="text-xl font-semibold text-zinc-900">
              {planDisplayName(billing.subscription.planId)}
            </span>
            {isTrialing && (
              <p className="mt-0.5 text-[11px] text-zinc-500">1 TB storage &amp; egress included</p>
            )}
            {!isTrialing && (
              <p className="mt-0.5 text-[11px] text-zinc-500">$4.99/TB · no egress fees</p>
            )}
          </div>
          <div>
            {isTrialing ? (
              <AppLink href="/billing" className="text-[12px]">
                Upgrade
              </AppLink>
            ) : (
              <AppLink href="/billing" className="text-[12px]">
                Manage plan
              </AppLink>
            )}
          </div>
        </Card>

        {/* Storage card */}
        <Card className="flex h-[157px] flex-col justify-between">
          <div>
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              STORAGE
            </span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[30px] font-semibold leading-9 tracking-tight text-zinc-900">
                {formatBytes(usage.storage.usedBytes)}
              </span>
              {isTrialing && <span className="text-[13px] text-zinc-500">/ 1 TB</span>}
            </div>
          </div>
          {isTrialing ? (
            <ProgressBar value={storagePct} size="sm" label="Storage usage" />
          ) : (
            <div className="flex items-center justify-between border-t border-zinc-200 pt-3">
              <span className="text-[11px] text-zinc-500">Est. monthly cost</span>
              <span className="text-[13px] font-semibold text-zinc-900">
                {estimateMonthlyCost(usage.storage.usedBytes, pricePerTbCents)}
              </span>
            </div>
          )}
        </Card>

        {/* Egress card */}
        <Card className="flex h-[157px] flex-col justify-between">
          <div>
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              EGRESS
            </span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[30px] font-semibold leading-9 tracking-tight text-zinc-900">
                {formatBytes(usage.egress.usedBytes)}
              </span>
              {isTrialing && <span className="text-[13px] text-zinc-500">/ 2 TB</span>}
            </div>
          </div>
          {isTrialing ? (
            <ProgressBar value={egressPct} size="sm" label="Egress usage" />
          ) : (
            <div className="flex items-center border-t border-zinc-200 pt-3">
              <span className="text-[11px] text-zinc-500">No egress fees · unlimited</span>
            </div>
          )}
        </Card>
      </div>

      {/* 5. Buckets · Objects · API Keys — single card with vertical dividers */}
      <Card padding="none" className="mb-5 grid grid-cols-3 divide-x divide-zinc-200">
        <div className="px-5 py-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              BUCKETS
            </span>
            <AppLink href="/buckets" className="text-[11px]">
              View all
            </AppLink>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-semibold text-zinc-900">{usage.buckets.count}</span>
            <span className="text-[11px] text-zinc-500">/ {usage.buckets.limit}</span>
          </div>
        </div>
        <div className="px-5 py-4">
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            OBJECTS
          </span>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-semibold text-zinc-900">{usage.objects.count}</span>
            <span className="text-[11px] text-zinc-500">total</span>
          </div>
        </div>
        <div className="px-5 py-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              API KEYS
            </span>
            <AppLink href="/api-keys" className="text-[11px]">
              View all
            </AppLink>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-semibold text-zinc-900">{usage.accessKeys.count}</span>
            <span className="text-[11px] text-zinc-500">/ {usage.accessKeys.limit}</span>
          </div>
        </div>
      </Card>

      {/* 6. Filecoin Sealing Status — hidden until event system is ready.
             Re-enable with <SealingStatus /> from ../components/SealingStatus.
             https://linear.app/filecoin-foundation/issue/FIL-77/object-sealing-live-updates-dashboard */}

      {/* 7. Usage Trends */}
      <Suspense fallback={<div className="mb-6" style={{ height: 200 }} />}>
        <UsageTrends />
      </Suspense>

      {/* 8. Recent Activity */}
      <Card>
        <div className="mb-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Recent Activity
          </h2>
        </div>

        {activities.length === 0 ? (
          <div className="flex flex-col items-center py-8 text-center">
            <p className="mb-1 text-sm font-medium text-zinc-900">No activity yet</p>
            <p className="mb-4 text-sm text-zinc-500">Create a bucket to start storing objects</p>
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
                          ? 'bg-zinc-100 text-zinc-500'
                          : 'bg-purple-50 text-purple-600'
                      }`}
                    >
                      {activity.resourceType}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-zinc-500">
                    {activity.action.replace('.', ' ')}
                  </p>
                </div>
                <span className="shrink-0 w-14 text-right text-[11px] text-zinc-500">
                  {timeAgo(activity.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
