// What the Billing tab says, decided in one place from what the API actually
// reports.
//
// The rule every function here follows: state a number only when the API gave
// us one. The tab used to compute money from a hardcoded $4.99 per TB, which is
// right for the self-serve price and fiction for every customer whose price
// sales put together in Stripe. `pricePerTbCents` and `monthlyMinimumCents` come
// from the price the subscription is billed on, and where they are absent this
// module says "see your agreement" rather than filling the gap in.

import { PlanId, SubscriptionStatus, TB_BYTES, getUsageLimits } from '@filone/shared';
import type { BillingInfo, Subscription } from '@filone/shared';

import { daysUntil, formatDate, formatMonthDay, pluralizeDays } from './time.js';

export type StatusTone = 'green' | 'blue' | 'amber' | 'red' | 'grey';

/** What the plan card's status pill says, and in what colour. */
export interface StatusBadge {
  label: string;
  tone: StatusTone;
  /** A dot suits a steady state; a change of state reads better without one. */
  dot: boolean;
}

export function statusBadge(status: SubscriptionStatus): StatusBadge {
  switch (status) {
    case SubscriptionStatus.Active:
      return { label: 'Active', tone: 'green', dot: true };
    // Past due is active access with a failed payment. The banner above the
    // cards is what says so; a red pill here would read as cancelled.
    case SubscriptionStatus.PastDue:
      return { label: 'Payment failed', tone: 'amber', dot: false };
    case SubscriptionStatus.Trialing:
      return { label: 'Trial', tone: 'blue', dot: true };
    case SubscriptionStatus.GracePeriod:
      return { label: 'Grace period', tone: 'amber', dot: false };
    case SubscriptionStatus.Canceled:
      return { label: 'Canceled', tone: 'red', dot: false };
    case SubscriptionStatus.Inactive:
      return { label: 'No plan', tone: 'grey', dot: false };
  }
}

/**
 * What to call the plan.
 *
 * "Free trial" while trialing, before anything else: Stripe attaches the
 * eventual paid price's product name to a trialing subscription too, and
 * showing that name here would call an account that has committed to
 * nothing and holds no card on file by the name of a plan it is not yet on.
 * Otherwise the Stripe product's name when there is one, because that is
 * what the customer's contract and their invoices call it. Then the
 * account's state, then the plan enum, and where none of those answers,
 * "Your plan". Never "Unknown": a label the console cannot fill is still a
 * plan somebody is paying for.
 */
export function planTitle(subscription: Subscription): string {
  if (subscription.status === SubscriptionStatus.Trialing) return 'Free trial';
  if (subscription.planName) return subscription.planName;

  switch (subscription.status) {
    case SubscriptionStatus.Inactive:
      return 'No plan';
    default:
      break;
  }

  // The enum, for an account Stripe has not named. It carries three values and
  // a negotiated quote is none of them, so it answers only where it can.
  switch (subscription.planId) {
    case PlanId.FreeTrial:
      return 'Free trial';
    case PlanId.PayAsYouGo:
      return 'Pay as you go';
    case PlanId.None:
      return 'No plan';
    default:
      return 'Your plan';
  }
}

/**
 * Money, grouped. The page's old helper was `toFixed(2)`, which is fine up to
 * $999.99 and prints a contracted `$2500.00` the moment somebody's minimum runs
 * into the thousands.
 */
export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * The line under the plan name: what this plan charges, in one clause.
 *
 * The rate and nothing else. The monthly minimum is a real fact but it is not
 * this line's job: quoted here it reads as a second price, and it only ever
 * matters when it is actually doing something — which is the one place it is
 * still said, on the estimate it holds up (see `costDisclosure`).
 *
 * With no rate at all — where a negotiated quote lands, since a volume deal has
 * no single per-TB number — this says so in two words rather than inventing one.
 */
export function pricingLine(subscription: Subscription): string {
  const { pricePerTbCents, status } = subscription;

  if (pricePerTbCents) return `${formatCents(pricePerTbCents)}/TB per month`;

  if (status === SubscriptionStatus.Trialing) {
    return `${formatBytesForCopy(getUsageLimits(false).storageLimitBytes)} of storage included`;
  }
  if (status === SubscriptionStatus.Inactive) return 'Choose a plan to start storing data';

  return 'Custom pricing';
}

/** Whole TB or GB, for a sentence rather than a table. */
function formatBytesForCopy(bytes: number): string {
  const tb = bytes / TB_BYTES;
  return tb >= 1 ? `${String(Math.round(tb))} TB` : `${String(Math.round(bytes / 1e9))} GB`;
}

/**
 * The plan's one line of detail: what it charges, then what happens next.
 *
 * One line rather than two stacked ones. They are both meta about the same
 * thing, and a card whose every line is a different shade of grey has no
 * hierarchy left to give the plan name.
 */
export function planMetaLine(subscription: Subscription): string {
  return [pricingLine(subscription), timelineLine(subscription)].filter(Boolean).join(' · ');
}

/**
 * The dated line: what happens next, and when.
 *
 * One line rather than a row of dates. Whichever deadline the account is up
 * against is the one worth showing, and for a healthy subscription that is the
 * renewal.
 */
export function timelineLine(subscription: Subscription): string | null {
  const { status, trialEndsAt, gracePeriodEndsAt, currentPeriodEnd, canceledAt } = subscription;

  if (status === SubscriptionStatus.Trialing && trialEndsAt) {
    return endsInLabel('Trial', trialEndsAt);
  }
  if (status === SubscriptionStatus.GracePeriod && gracePeriodEndsAt) {
    return endsInLabel('Access', gracePeriodEndsAt);
  }
  if (status === SubscriptionStatus.Canceled) {
    return canceledAt ? `Canceled ${formatDate(canceledAt)}` : 'Canceled';
  }
  if (currentPeriodEnd) return `Renews ${formatDate(currentPeriodEnd)}`;
  return null;
}

/**
 * "Trial ends in 12 days", with the last day of it spelled out rather than
 * counted: `daysUntil` clamps at zero, so 0 is later today, not gone.
 */
function endsInLabel(subject: string, iso: string): string {
  const days = daysUntil(iso);
  return days === 0 ? `${subject} ends today` : `${subject} ends in ${pluralizeDays(days)}`;
}

/**
 * The dates the usage figures cover, and how much of the period is left.
 *
 * Both ends or neither: "to Sep 14" alone does not say what it is counting from,
 * and a start guessed by subtracting a month from the end would be wrong in
 * every month that is not thirty days. Records written before the start was
 * stored get no range rather than half of one.
 *
 * The year is stated once, at the far end. How much of the period is left is
 * `daysLeftLabel`, beside this rather than inside it.
 */
export function billingPeriodRange(subscription: Subscription): string | null {
  const { currentPeriodStart, currentPeriodEnd } = subscription;
  if (!currentPeriodStart || !currentPeriodEnd) return null;

  const sameYear =
    new Date(currentPeriodStart).getFullYear() === new Date(currentPeriodEnd).getFullYear();
  const from = sameYear ? formatMonthDay(currentPeriodStart) : formatDate(currentPeriodStart);

  return `${from} – ${formatDate(currentPeriodEnd)}`;
}

/**
 * How much of the period is left, for the badge beside the dates.
 *
 * Split from the range rather than joined to it: an estimate means one thing on
 * the second day of a period and something else on the twenty-eighth, and a
 * count that carries that weight reads better as its own mark than as the tail
 * of a date string.
 */
export function daysLeftLabel(subscription: Subscription): string | null {
  if (!subscription.currentPeriodEnd) return null;
  const days = daysUntil(subscription.currentPeriodEnd);
  return days === 0 ? 'Ends today' : `${pluralizeDays(days)} left`;
}

/**
 * What the storage line itself costs, when the rate is known.
 *
 * The breakdown's own arithmetic: with a cost against each row, the total below
 * is something the reader can check rather than take on trust. Null wherever no
 * rate was reported, which is the same condition that leaves the total to
 * Stripe.
 */
export function storageCostCents(
  subscription: Subscription,
  storageBytesUsed: number,
): number | null {
  if (!isBilling(subscription.status) || !subscription.pricePerTbCents) return null;
  return Math.round((storageBytesUsed / TB_BYTES) * subscription.pricePerTbCents);
}

/**
 * What the usage section can say about the bill, which is one of three things.
 *
 * `estimate` only where the rate is known and usage is what drives the invoice.
 * `agreement` where the plan is billed but no rate was reported: the number is
 * in Stripe and this console is not going to guess at it. `none` where nothing
 * is being billed yet.
 */
export type CostDisclosure =
  | { kind: 'estimate'; cents: number; minimumApplied: boolean }
  | { kind: 'agreement' }
  | { kind: 'none' };

export function costDisclosure(
  subscription: Subscription,
  storageBytesUsed: number,
): CostDisclosure {
  if (!isBilling(subscription.status)) return { kind: 'none' };

  const { pricePerTbCents, monthlyMinimumCents = 0 } = subscription;
  if (!pricePerTbCents) return { kind: 'agreement' };

  const usageCents = Math.round((storageBytesUsed / TB_BYTES) * pricePerTbCents);
  return {
    kind: 'estimate',
    cents: Math.max(usageCents, monthlyMinimumCents),
    minimumApplied: monthlyMinimumCents > usageCents,
  };
}

/** The states where an invoice is being run up, so a cost line means something. */
function isBilling(status: SubscriptionStatus): boolean {
  return (
    status === SubscriptionStatus.Active ||
    status === SubscriptionStatus.PastDue ||
    status === SubscriptionStatus.GracePeriod
  );
}

/**
 * The allowance a meter can be drawn against, or null for no meter at all.
 *
 * A trial has a real ceiling and a bar answers "how much is left". A paid plan
 * does not: storage is unlimited on the self-serve price, and on a contract the
 * ceiling is in the contract and not in this API. A bar against a made-up limit
 * is the worst of the options, so paid plans get a number and no bar.
 */
export function usageLimits(status: SubscriptionStatus): {
  storageLimitBytes: number | null;
  egressLimitBytes: number | null;
} {
  if (status !== SubscriptionStatus.Trialing) {
    return { storageLimitBytes: null, egressLimitBytes: null };
  }
  const limits = getUsageLimits(false);
  return {
    storageLimitBytes: limits.storageLimitBytes || null,
    egressLimitBytes: limits.egressLimitBytes || null,
  };
}

/**
 * Whether to offer the sales conversation.
 *
 * Only to accounts that have not bought yet. An org already on a plan does not
 * want its billing settings pitching an upgrade at it, and an org on a
 * negotiated contract has an account team already: telling them about "the
 * Business plan" is the console admitting it does not know who it is talking to.
 */
export function showsSalesPitch(status: SubscriptionStatus): boolean {
  return status === SubscriptionStatus.Trialing || status === SubscriptionStatus.Inactive;
}

/**
 * How the account pays, when it is not by a card on file.
 *
 * A billed account with no card is not a missing card: Stripe invoices
 * contracted customers, and "No payment method added" over an active Business
 * plan reads as something broken. Distinguished from the trial case, where a
 * card genuinely does need adding before the trial runs out.
 */
export type PaymentPosture = 'card' | 'invoiced' | 'needs-card';

export function paymentPosture(billing: BillingInfo): PaymentPosture {
  if (billing.paymentMethod) return 'card';
  return isBilling(billing.subscription.status) ? 'invoiced' : 'needs-card';
}
