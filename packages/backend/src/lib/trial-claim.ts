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

import { listMemberships } from './org-membership.js';
import type { SubscriptionRecord } from './dynamo-records.js';
import { emitTrialClaimBlockedByLegacyRow } from './stripe-webhook-metrics.js';
import { legacyRowExists, readSubscription } from './subscription-store.js';
import { ensureTrialEntitlement } from './trial-entitlement.js';
import type { UserInfo } from './user-context.js';

export type TrialClaimOutcome =
  /** A trial now exists for this org. */
  | 'claimed'
  /** An API key session; `sub` names a credential, not a person who can hold a claim. */
  | 'api-key-session'
  /** Somebody else's org, or one of several — the claim is not spendable here. */
  | 'not-own-org'
  /** Eligible to claim, but the entitlement is already spent (or the email is unverified). */
  | 'not-entitled'
  /** The backfill missed this account: billing stands on the user's pre-re-key row and not on the org's. */
  | 'legacy-row';

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
 * Only in their own org, and only while it is the only one they belong to
 * (ADR §5). Without the personal-org condition this would create Stripe billing
 * on somebody else's org, anchoring that org's subscription to this caller's
 * Stripe customer; without the sole-membership condition, every employee of an
 * org who ever opened their personal dashboard would mint a trial nobody asked
 * for. A member who genuinely wants personal use activates billing explicitly,
 * and their claim is still theirs to spend.
 *
 * Decided from stored rows, never from the request: `X-Org-Id` names the org but
 * cannot prove whose it is. `source` says how the membership came to be — an
 * invitation is somebody else's org by construction — and the inverse items say
 * how many orgs the caller belongs to.
 */
export async function claimTrialIfEligible(userInfo: UserInfo): Promise<TrialClaimOutcome> {
  const { sub, userId, orgId, email, emailVerified, apiKeySession } = userInfo;
  if (apiKeySession) return 'api-key-session';

  if (!(await isSoloPersonalOrg(userInfo))) return 'not-own-org';

  // Here rather than at a call site, and immediately before the mint. The claim
  // mints a Stripe customer and a subscription; if a pre-re-key `CUSTOMER#` row
  // is still standing for this user, the backfill missed their account and this
  // org already has billing that nothing reading the org key can see. Minting
  // would give one account two Stripe customers, two subscriptions and two
  // meters, which no later run can undo. Any route that can reach this function
  // can reach that outcome, so the refusal cannot live in one of them — and
  // every path that mints runs through this line, because the mint is the next
  // one.
  //
  // The row is the user's, so it says nothing about an org they were invited
  // to: refusing before the ownership test answered "billing is unavailable" —
  // a 503, the on-call's signal — for a member simply opening a second org, and
  // the runbook's cleanup precondition reads that denial rate.
  //
  // A dead check once the runbook's dated cleanup has deleted those rows, and
  // it goes with them.
  //
  // A standing `CUSTOMER#` row on its own does not say the backfill missed the
  // account: the flip gate requires the twin, so during the dual-write window
  // the common case is a row on both keys. The refusal is about billing this
  // org has that nothing reading the org key can see, so it asks the org key
  // and refuses only when the answer is nothing. Otherwise the org row is what
  // the claim reads anyway — `createBillingTrial` upgrades it in place and
  // reuses its `stripeCustomerId`, so no second Stripe customer can be minted.
  if (await legacyRowExists(userId)) {
    const orgRow = await readSubscription(orgId, {
      consistentRead: true,
      projectionExpression: 'pk',
    });
    if (!orgRow) {
      emitTrialClaimBlockedByLegacyRow();
      console.error(
        '[trial-claim] Refusing to mint a trial: a pre-re-key CUSTOMER# row exists and the org row does not',
        { userId, orgId },
      );
      return 'legacy-row';
    }
  }

  const entitled = await ensureTrialEntitlement({
    sub,
    userId,
    orgId,
    email: email ?? null,
    emailVerified,
  });
  return entitled ? 'claimed' : 'not-entitled';
}

/**
 * Every refusal branch logs before returning, unlike the eligible path (which
 * has nothing to say — `claimTrialIfEligible`'s own caller already knows it
 * asked). Silent until now: a `not-own-org` outcome gave no way to tell "the
 * caller genuinely holds no trial-eligible membership" apart from "something
 * upstream resolved `userInfo.membership` incorrectly for this request",
 * which look identical from the response alone.
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
  if (membership.source === 'invitation') {
    console.warn('[trial-claim] Membership arrived by invitation — refusing the claim', {
      userId,
      orgId,
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
