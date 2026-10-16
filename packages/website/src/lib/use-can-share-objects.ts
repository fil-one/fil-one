import { useQuery } from '@tanstack/react-query';

import { SubscriptionStatus } from '@filone/shared';

import { getBilling } from './api.js';
import { queryKeys } from './query-client.js';
import { useHasPermission } from './use-permissions.js';

/** What a disabled Share control says, wherever it appears. */
export const SHARE_UNAVAILABLE_TOOLTIP =
  'Sharing is not available during the trial period. Upgrade to a paid plan to share objects.';

/**
 * Whether the org's plan lets it create share links, for every Share control
 * in the console (the object page and each object row).
 *
 * With billing readable this is an allowlist: a status the list doesn't know
 * (inactive, say) must not enable sharing. A Member cannot read billing at
 * all, and inferring "trial" from an absent answer disabled Share for every
 * Member on a paid plan and told them the trial was why. The presign endpoint
 * applies the same subscription rule server-side, so the honest default when
 * the console cannot see the plan is to offer the control.
 */
export function useCanShareObjects(): boolean {
  const mayReadBilling = useHasPermission('billing.view');
  const { data: billing } = useQuery({
    queryKey: queryKeys.billing,
    queryFn: getBilling,
    enabled: mayReadBilling,
  });
  const status = billing?.subscription.status;
  return (
    !mayReadBilling ||
    status === SubscriptionStatus.Active ||
    status === SubscriptionStatus.PastDue ||
    status === SubscriptionStatus.GracePeriod
  );
}
