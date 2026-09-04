import { lazy, Suspense, useState } from 'react';
import {
  PlusIcon,
  DatabaseIcon,
  KeyIcon,
  CloudArrowUpIcon,
  XIcon,
  CheckIcon,
} from '@phosphor-icons/react/dist/ssr';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Link as AppLink } from '../components/Link';

const UsageTrends = lazy(() => import('./UsageTrends'));

import { PageLayout } from '../components/PageLayout.js';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { Badge, type BadgeColor } from '../components/Badge';
import { Card } from '../components/Card';
import { IconBox } from '../components/IconBox';
import { ProgressBar } from '../components/ProgressBar';
import { formatBytes } from '@filone/shared';

import { getActivityActionLabel, PlanId, SubscriptionStatus, getUsageLimits } from '@filone/shared';
import type { RecentActivity } from '@filone/shared';

import { getUsage, getBilling, getActivity } from '../lib/api.js';
import { daysUntil, formatDateTime, timeAgo } from '../lib/time.js';
import { costDisclosure, formatCents, planTitle, pricingLine } from '../lib/billing-view.js';
import { queryKeys, USAGE_STALE_TIME } from '../lib/query-client.js';
import { RequirePermission } from '../components/RequirePermission';
import { useHasPermission } from '../lib/use-permissions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadgeProps(status: SubscriptionStatus): { label: string; color: BadgeColor } {
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
    case SubscriptionStatus.Inactive:
      return { label: 'No plan', color: 'grey' };
    default: {
      // A new SubscriptionStatus member must fail the typecheck here rather
      // than silently render the raw enum string as a badge.
      const _never: never = status;
      return { label: String(_never), color: 'grey' };
    }
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function DashboardSkeleton() {
  return (
    <div className="p-8 animate-pulse">
      <div className="mb-6 h-8 w-40 rounded bg-zinc-200" />
      <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
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
  // A prompt toward pages the caller can always reach on their own (Buckets,
  // API Keys), so dismissing it costs nothing — it just stops asking, the way
  // the trial banner above it does.
  const [quickSetupVisible, setQuickSetupVisible] = useState(true);

  // Money is `billing.view`. A Member's dashboard used to sit on a skeleton
  // forever waiting for a request that returns 403, so the plan panels are now
  // the only thing that depends on billing, and they are simply absent for a
  // role that cannot read it.
  const mayReadBilling = useHasPermission('billing.view');

  const { data: usage, isPending: usagePending } = useQuery({
    queryKey: queryKeys.usage,
    queryFn: getUsage,
    staleTime: USAGE_STALE_TIME,
  });

  const { data: billingData } = useQuery({
    queryKey: queryKeys.billing,
    queryFn: getBilling,
    enabled: mayReadBilling,
  });
  // Read through the permission, not just the `enabled` flag. A mounted page is
  // a live observer, so nothing collects the answer this query already has, and
  // react-query keeps serving it once the query is disabled — the plan card,
  // the trial banner and the cost estimate would all keep rendering after a
  // demotion. Reading it here makes every derived value go absent at once.
  const billing = mayReadBilling ? billingData : undefined;

  // Activity is optional — silently ignored if it fails
  const { data: activityData } = useQuery({
    queryKey: queryKeys.activityRecent(5),
    queryFn: () => getActivity({ limit: 5 }),
  });
  const activities: RecentActivity[] = activityData?.activities ?? [];

  // Usage alone decides whether there is a page: every counter and the quick
  // setup read it, and it is `buckets.read`, which every role holds.
  if (usagePending || !usage) {
    return <DashboardSkeleton />;
  }

  const isTrialing = billing?.subscription.status === SubscriptionStatus.Trialing;
  const isActivePaid = billing?.subscription.status === SubscriptionStatus.Active;
  const isInactive = billing?.subscription.status === SubscriptionStatus.Inactive;
  // Positive check for paid-plan copy (pricing, cost estimate): planId `none`
  // and the trial both stay excluded, instead of inferring "paid" from
  // !isTrialing.
  const isPayAsYouGo = billing?.subscription.planId === PlanId.PayAsYouGo;
  const trialDaysLeft =
    isTrialing && billing?.subscription.trialEndsAt
      ? daysUntil(billing.subscription.trialEndsAt)
      : null;
  const trialEndsLabel = billing?.subscription.trialEndsAt
    ? `Expires ${formatDateTime(billing.subscription.trialEndsAt)}`
    : undefined;

  // Quick setup is onboarding: it tells a new account what to do next. A
  // disabled account cannot do any of it, and the steps it lists are not the
  // step that gets the account back, so it competes with the banner that names
  // the one action that matters. Restoring access is the only next step there.
  const showQuickSetup =
    usage.tenantStatus !== 'disabled' &&
    (usage.buckets.count === 0 || usage.objects.count === 0 || usage.accessKeys.count === 0);

  const badge = billing ? statusBadgeProps(billing.subscription.status) : null;
  // The rate comes from the price the org is billed on. This card used to
  // multiply by a hardcoded $4.99 per TB, so an org on a quoted price was shown
  // an estimate for a rate it does not pay.
  const cost = billing ? costDisclosure(billing.subscription, usage.storage.usedBytes) : null;

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
      id: 'generate-key',
      icon: KeyIcon,
      title: 'Generate API key',
      subtitle: 'Connect via S3 API',
      href: '/api-keys',
      done: usage.accessKeys.count > 0,
    },
    {
      id: 'upload-object',
      icon: CloudArrowUpIcon,
      title: 'Upload an object',
      subtitle: 'Store files on Fil One',
      href: '/buckets',
      done: usage.objects.count > 0,
    },
  ];

  const quickSetupDone = quickSetupTasks.filter((t) => t.done).length;
  const quickSetupTotal = quickSetupTasks.length;

  return (
    <PageLayout
      title="Dashboard"
      headingId="dashboard-heading"
      action={
        <RequirePermission permission="buckets.create">
          <Button
            id="dashboard-new-bucket-button"
            variant="ghost"
            size="sm"
            icon={PlusIcon}
            href="/buckets"
          >
            New bucket
          </Button>
        </RequirePermission>
      }
    >
      {/* 2. Trial banner */}
      {isTrialing && trialBannerVisible && (
        <div className="mb-5 flex flex-col gap-3 rounded-xl bg-brand-50/60 px-5 py-3.5 shadow-[0px_0px_0px_1px_theme(colors.brand.100)] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <Badge color="blue" size="sm" strength="strong" description={trialEndsLabel}>
              {trialDaysLeft !== null ? `${trialDaysLeft} days left` : 'TRIAL'}
            </Badge>
            <p className="text-[13px]">
              <span className="font-medium text-zinc-900">Free trial</span>
              <span className="text-zinc-500">
                {' '}
                — Add a payment method to unlock unlimited storage at $4.99/TB
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2 self-end sm:self-auto">
            <Button variant="primary" size="sm" href="/billing">
              Upgrade
            </Button>
            <IconButton
              icon={XIcon}
              aria-label="Dismiss trial banner"
              onClick={() => setTrialBannerVisible(false)}
              size="sm"
            />
          </div>
        </div>
      )}

      {/* 3. Quick Setup */}
      {showQuickSetup && quickSetupVisible && (
        <Card className="mb-5">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-meta font-medium uppercase tracking-wider text-zinc-500">
              QUICK SETUP
            </span>
            <div className="flex items-center gap-3">
              <span className="text-meta text-zinc-500">
                {quickSetupDone} of {quickSetupTotal}
              </span>
              <IconButton
                icon={XIcon}
                aria-label="Dismiss quick setup"
                onClick={() => setQuickSetupVisible(false)}
                size="sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {quickSetupTasks.map(({ id, icon: Icon, title, subtitle, href, done }) => (
              <Link
                key={id}
                to={href}
                className={`flex items-center gap-3 rounded-lg border p-4 ${
                  done ? 'border-green-200 bg-green-50' : 'border-zinc-200 hover:bg-zinc-50'
                }`}
              >
                <IconBox icon={done ? CheckIcon : Icon} color={done ? 'green' : 'blue'} size="md" />
                <div className="min-w-0">
                  <p className={`text-ui font-medium ${done ? 'text-green-900' : 'text-zinc-900'}`}>
                    {title}
                  </p>
                  <p className={`text-meta ${done ? 'text-green-700' : 'text-zinc-500'}`}>
                    {subtitle}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {/* 4. Top row: Plan · Storage · Egress. The plan card is absent, not
             skeletal, for a role that cannot read billing — the counters beside
             it are `buckets.read` and stand on their own. */}
      <div
        className={`mb-3 grid grid-cols-1 gap-3 ${billing ? 'lg:grid-cols-3' : 'lg:grid-cols-2'}`}
      >
        {/* Plan card */}
        {billing && badge && (
          <Card className="flex flex-col justify-between sm:h-[157px]">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                  PLAN
                </span>
                <span data-testid="subscription-status" data-status={billing.subscription.status}>
                  {isTrialing && trialDaysLeft !== null && (
                    <Badge color="blue" size="sm" description={trialEndsLabel}>
                      {trialDaysLeft} days left
                    </Badge>
                  )}
                  {!isTrialing && (
                    <Badge color={badge.color} size="sm">
                      {badge.label}
                    </Badge>
                  )}
                </span>
              </div>
              <span className="text-xl font-medium text-zinc-900">
                {planTitle(billing.subscription)}
              </span>
              {isTrialing && (
                <p className="mt-0.5 text-[11px] text-zinc-500">
                  {formatBytes(limits.storageLimitBytes)} storage ·{' '}
                  {formatBytes(limits.egressLimitBytes)} egress included
                </p>
              )}
              {isInactive && (
                <p className="mt-0.5 text-[11px] text-zinc-500">
                  Choose a plan to start storing data
                </p>
              )}
              {isPayAsYouGo && billing && (
                <p className="mt-0.5 text-[11px] text-zinc-500">
                  {pricingLine(billing.subscription)} · no egress fees
                </p>
              )}
            </div>
            <div>
              {isTrialing || isInactive ? (
                <AppLink href="/billing" className="text-[12px]">
                  {isInactive ? 'Choose a plan' : 'Upgrade'}
                </AppLink>
              ) : (
                <AppLink href="/billing" className="text-[12px]">
                  Manage plan
                </AppLink>
              )}
            </div>
          </Card>
        )}

        {/* Storage card */}
        <Card className="flex flex-col justify-between sm:h-[157px]">
          <div>
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              STORAGE
            </span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl font-medium text-zinc-900">
                {formatBytes(usage.storage.usedBytes)}
              </span>
              {isTrialing && <span className="text-[13px] text-zinc-500">/ 1 TB</span>}
            </div>
          </div>
          {isTrialing && <ProgressBar value={storagePct} size="sm" label="Storage usage" />}
          {/* Only where the price states a rate. A quoted price has no single
              per-TB number, and the Billing tab is where that total lives. */}
          {cost?.kind === 'estimate' && (
            <div className="flex items-center justify-between border-t border-zinc-200 pt-3">
              <span className="text-[11px] text-zinc-500">Est. monthly cost</span>
              <span className="text-[13px] font-medium text-zinc-900">
                {formatCents(cost.cents)}
              </span>
            </div>
          )}
        </Card>

        {/* Egress card */}
        <Card className="flex flex-col justify-between sm:h-[157px]">
          <div>
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              EGRESS
            </span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl font-medium text-zinc-900">
                {formatBytes(usage.egress.usedBytes)}
              </span>
              {isTrialing && <span className="text-[13px] text-zinc-500">/ 2 TB</span>}
            </div>
          </div>
          {isTrialing && <ProgressBar value={egressPct} size="sm" label="Egress usage" />}
          {isPayAsYouGo && (
            <div className="flex items-center border-t border-zinc-200 pt-3">
              <span className="text-[11px] text-zinc-500">No egress fees · unlimited</span>
            </div>
          )}
        </Card>
      </div>

      {/* 5. Buckets · Objects · API Keys — single card with vertical dividers */}
      <Card
        padding="none"
        className="mb-5 grid grid-cols-1 divide-y divide-zinc-200 lg:grid-cols-3 lg:divide-x lg:divide-y-0"
      >
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
            <span className="text-xl font-medium text-zinc-900">{usage.buckets.count}</span>
            <span className="text-[11px] text-zinc-500">total</span>
          </div>
        </div>
        <div className="px-5 py-4">
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            OBJECTS
          </span>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-medium text-zinc-900">{usage.objects.count}</span>
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
            <span className="text-xl font-medium text-zinc-900">{usage.accessKeys.count}</span>
            <span className="text-[11px] text-zinc-500">total</span>
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
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <p className="mb-1 text-sm font-medium text-zinc-900">No activity yet</p>
            <p className="mb-4 max-w-xs text-sm text-zinc-500">
              Create a bucket to start storing objects
            </p>
            <RequirePermission permission="buckets.create">
              <Button
                id="dashboard-create-bucket-button"
                variant="primary"
                icon={PlusIcon}
                href="/buckets"
              >
                Create bucket
              </Button>
            </RequirePermission>
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
                    <Badge color={activity.resourceType === 'bucket' ? 'grey' : 'blue'} size="sm">
                      {activity.resourceType}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-[11px] text-zinc-500">
                    {getActivityActionLabel(activity.action)}
                  </p>
                </div>
                <span className="w-14 shrink-0 text-right text-[11px] text-zinc-500">
                  {timeAgo(activity.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </PageLayout>
  );
}
