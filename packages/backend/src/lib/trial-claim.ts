// The one place a trial is claimed from a request (IAM M1, ADR §4 removed the
// two on the login path).
//
// Two callers reach it, and they must agree to the letter: the subscription
// guard, which blocks a request that finds no entitlement, and GET /api/billing,
// which the dashboard calls first and which no guard sits in front of. If only
// the guard claimed, an organic signup would land on a dashboard that reads its
// own billing as inactive and would stay that way until the user happened to
// touch a gated route — the ADR promises the trial exists by the first API call.
//
// So the eligibility test and the claim live here, and the two callers differ
// only in what they do with the outcome.

import { listMemberships } from './org-membership.ts';
import type { SubscriptionRecord } from './dynamo-records.ts';
import { ensureTrialEntitlement } from './trial-entitlement.ts';
import type { UserInfo } from './user-context.ts';

export type TrialClaimOutcome =
  /** A trial now exists for this org. */
  | 'claimed'
  /** An API key session; `sub` names a credential, not a person who can hold a claim. */
  | 'api-key-session'
  /** Somebody else's org, or one of several — the claim is not spendable here. */
  | 'not-own-org'
  /** Eligible to claim, but the entitlement is already spent (or the email is unverified). */
  | 'not-entitled';

/**
 * Whether the trial claim is still open for a stored record.
 *
 * No record at all, obviously. But also a record with neither a status nor a
 * subscription: that is what `create-setup-intent` leaves behind when somebody
 * opens the payment modal and closes it, a customer mapping and nothing else.
 * Treating it as a subscription would forfeit the trial permanently for the one
 * user who looked at the pricing page first, so the claim runs and upgrades the
 * row in place, keeping the `stripeCustomerId` already on it.
 */
export function isTrialClaimable(record: SubscriptionRecord | undefined): boolean {
  if (!record) return true;
  return !record.subscriptionStatus && !record.subscriptionId;
}

/**
 * Claim the trial when this caller may spend theirs on this org.
 *
 * Only in the org that came with their account, and only while it is the only
 * one they belong to (ADR §5). An org the account created, or the floor org a
 * removal made, never earns one: the trial belongs to a new account, not to
 * every org somebody makes after joining someone else's. Without the personal-org condition this would create Stripe billing
 * on somebody else's org, anchoring that org's subscription to this caller's
 * Stripe customer; without the sole-membership condition, every employee of an
 * org who ever opened their personal dashboard would mint a trial nobody asked
 * for. A member who genuinely wants personal use activates billing explicitly,
 * and their claim is still theirs to spend.
 *
 * Decided from stored rows, never from the request: `X-Org-Id` names the org but
 * cannot prove whose it is. `source` says how the membership came to be — an
 * invitation is somebody else's org by construction, and a manual one is not
 * the account's own — and the inverse items say how many orgs the caller
 * belongs to.
 */
export async function claimTrialIfEligible(userInfo: UserInfo): Promise<TrialClaimOutcome> {
  const { sub, userId, orgId, email, emailVerified, apiKeySession } = userInfo;
  if (apiKeySession) return 'api-key-session';

  if (!(await isSoloPersonalOrg(userInfo))) return 'not-own-org';

  const entitled = await ensureTrialEntitlement({
    sub,
    userId,
    orgId,
    email: email ?? null,
    emailVerified,
    membershipSource: userInfo.membership?.source,
  });
  return entitled ? 'claimed' : 'not-entitled';
}

/**
 * Every refusal logs, so a `not-own-org` outcome can be told apart from an
 * upstream bug that resolved `userInfo.membership` wrongly for this request.
 */
async function isSoloPersonalOrg({ userId, orgId, membership }: UserInfo): Promise<boolean> {
  if (!membership || membership.orgId !== orgId) {
    console.warn('[trial-claim] No membership row for the active org — refusing the claim', {
      userId,
      orgId,
      membershipOrgId: membership?.orgId,
    });
    return false;
  }
  if (membership.source === 'invitation' || membership.source === 'manual') {
    console.warn('[trial-claim] Not the org that came with the account — refusing the claim', {
      userId,
      orgId,
      source: membership.source,
    });
    return false;
  }

  const memberships = await listMemberships(userId);
  if (memberships.length !== 1 || memberships[0]?.orgId !== orgId) {
    console.warn('[trial-claim] Caller belongs to more than this one org — refusing the claim', {
      userId,
      orgId,
      membershipCount: memberships.length,
    });
    return false;
  }
  return true;
}
