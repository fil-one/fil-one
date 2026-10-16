// Which org a pre-717 trial entitlement claim was spent on, decided from the
// rows the prefill reads. The runner is ../prefill-trial-entitlement-org.ts.

import type { OrgMembershipSource } from '@filone/shared';
import type { SubscriptionRecord } from '@filone/backend/src/lib/dynamo-records.ts';
import { isTrialClaimable } from '@filone/backend/src/lib/trial-claim.ts';

export type TrialOrgResolution =
  | { orgId: string; via: 'billing' | 'home-org' }
  | { reason: string };

/**
 * Whether an org's subscription row records a trial or subscription for the
 * claim's owner. A customer mapping left by an abandoned card form does not:
 * the claim reads it as still open, and so does this.
 */
export function billsTrialTo(row: Partial<SubscriptionRecord>, userId: string): boolean {
  return row.userId === userId && !isTrialClaimable(row as SubscriptionRecord);
}

/** A membership that came with the account, the only kind the claim could be spent on. */
export function isHomeMembership(source: OrgMembershipSource | undefined): boolean {
  return source !== 'invitation' && source !== 'manual';
}

/**
 * The org whose billing row carries the user's trial or subscription, else the
 * one org that came with the account. Anything else is left for an operator.
 */
export function resolveTrialOrg({
  billingOrgIds,
  homeOrgIds,
}: {
  billingOrgIds: readonly string[];
  homeOrgIds: readonly string[];
}): TrialOrgResolution {
  if (billingOrgIds.length === 1) return { orgId: billingOrgIds[0]!, via: 'billing' };
  if (billingOrgIds.length > 1) {
    return { reason: `billing names several orgs: ${billingOrgIds.join(', ')}` };
  }
  if (homeOrgIds.length === 1) return { orgId: homeOrgIds[0]!, via: 'home-org' };
  if (homeOrgIds.length > 1) return { reason: `several home orgs: ${homeOrgIds.join(', ')}` };
  return { reason: 'no billing row and no home org' };
}
