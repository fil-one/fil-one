import { useQuery } from '@tanstack/react-query';
import { SubscriptionStatus, getUsageLimits } from '@filone/shared';
import { getBilling, getMe, getUsage } from '../lib/api.js';
import { queryKeys, USAGE_STALE_TIME } from '../lib/query-client.js';
import { useHasPermission } from '../lib/use-permissions.js';
import { daysUntil, formatDateTime } from '../lib/time.js';
import { monogramFromName } from '../lib/monogram.js';

export function useSidebarData() {
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: () => getMe() });
  // Every banner below the nav is a billing fact, and `billing.view` is what
  // says whether the console may know them. Without it the request is not made,
  // and the banners are absent rather than guessed at.
  const mayReadBilling = useHasPermission('billing.view');
  const { data: billingData } = useQuery({
    queryKey: queryKeys.billing,
    queryFn: getBilling,
    enabled: mayReadBilling,
  });
  // Read through the permission, not just the `enabled` flag. A mounted sidebar
  // is a live observer, so a disabled query keeps serving the answer it already
  // has — the "No active plan" and "Payment failed" banners would keep offering
  // a /billing button the caller can no longer open. Same read as
  // `DashboardPage.tsx`, so every derived value goes absent at once.
  const billing = mayReadBilling ? billingData : undefined;
  const { data: usage } = useQuery({
    queryKey: queryKeys.usage,
    queryFn: getUsage,
    staleTime: USAGE_STALE_TIME,
  });

  const displayName = me?.name || me?.email || 'User';
  const isTrialing = billing?.subscription.status === SubscriptionStatus.Trialing;
  const isPastDue = billing?.subscription.status === SubscriptionStatus.PastDue;
  const isActivePaid = billing?.subscription.status === SubscriptionStatus.Active;
  const isInactive = billing?.subscription.status === SubscriptionStatus.Inactive;
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
  // `getUsageLimits(false)` is the free-tier allowance, which is the right
  // answer for a trial and a lie for anyone whose plan the console cannot read:
  // a Member on pay-as-you-go would have seen a meter filling toward 1 TB.
  // Without billing there is no limit to measure against, so the meters show
  // usage and drop the denominator.
  const limits = getUsageLimits(!!isActivePaid);
  const storageUsed = usage?.storage.usedBytes ?? 0;
  const egressUsed = usage?.egress.usedBytes ?? 0;
  const limitsKnown = billing !== undefined;
  const storagePct =
    limitsKnown && limits.storageLimitBytes > 0
      ? Math.min(100, (storageUsed / limits.storageLimitBytes) * 100)
      : 0;
  const egressPct =
    limitsKnown && limits.egressLimitBytes > 0
      ? Math.min(100, (egressUsed / limits.egressLimitBytes) * 100)
      : 0;

  return {
    me,
    displayName,
    initial: monogramFromName(displayName),
    isTrialing,
    isPastDue,
    isInactive,
    trialDays,
    trialEndsLabel,
    graceDays,
    graceEndsLabel,
    storageUsed,
    storagePct,
    egressUsed,
    egressPct,
    /** Whether a meter has a denominator to show. False hides the limit. */
    limitsKnown,
  };
}
