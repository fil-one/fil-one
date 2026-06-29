import { useQuery } from '@tanstack/react-query';
import { SubscriptionStatus, getUsageLimits } from '@filone/shared';
import { getBilling, getMe, getUsage } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';
import { daysUntil, formatDateTime } from '../lib/time.js';

export function useSidebarData() {
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: () => getMe() });
  const { data: billing } = useQuery({ queryKey: queryKeys.billing, queryFn: getBilling });
  const { data: usage } = useQuery({ queryKey: queryKeys.usage, queryFn: getUsage });

  const displayName = me?.name || me?.email || 'User';
  const isTrialing = billing?.subscription.status === SubscriptionStatus.Trialing;
  const isPastDue = billing?.subscription.status === SubscriptionStatus.PastDue;
  const isActivePaid = billing?.subscription.status === SubscriptionStatus.Active;
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
  const limits = getUsageLimits(!!isActivePaid);
  const storageUsed = usage?.storage.usedBytes ?? 0;
  const storagePct =
    limits.storageLimitBytes > 0
      ? Math.min(100, (storageUsed / limits.storageLimitBytes) * 100)
      : 0;
  const egressUsed = usage?.egress.usedBytes ?? 0;
  const egressPct =
    limits.egressLimitBytes > 0 ? Math.min(100, (egressUsed / limits.egressLimitBytes) * 100) : 0;

  return {
    me,
    displayName,
    initial: displayName.charAt(0).toUpperCase(),
    isTrialing,
    isPastDue,
    trialDays,
    trialEndsLabel,
    graceDays,
    graceEndsLabel,
    storageUsed,
    storagePct,
    egressUsed,
    egressPct,
  };
}
