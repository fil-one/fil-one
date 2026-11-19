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
import type { BillingInfo, Subscription, SubscriptionDiscount } from '@filone/shared';

import { daysUntil, formatDate, formatDaysLeft, formatMonthDay, pluralizeDays } from './time.js';

export type StatusTone = 'amber' | 'red';

/** What the plan card's status pill says, and in what colour. */
export interface StatusBadge {
  label: string;
  tone: StatusTone;
}

/**
 * The plan card's status pill, for a plan that needs attention, and null for
 * one that does not.
 *
 * A plan in good standing (running, billed manually, or mid-trial) gets no
 * pill: it is the normal state, and an "Active" pill on it said nothing the
 * card did not already, while making the pills that matter easier to miss.
 * An account with no plan gets none either, since its name already says so.
 */
export function statusBadge(status: SubscriptionStatus): StatusBadge | null {
  switch (status) {
    case SubscriptionStatus.Active:
    case SubscriptionStatus.Manual:
    case SubscriptionStatus.Trialing:
    case SubscriptionStatus.Inactive:
      return null;
    // Past due is a failed payment Stripe is still retrying: the subscription
    // stands, though the account is read-only until it is paid. The banner
    // above the cards says so; a red pill here would read as cancelled.
    case SubscriptionStatus.PastDue:
      return { label: 'Payment failed', tone: 'amber' };
    case SubscriptionStatus.GracePeriod:
      return { label: 'Grace period', tone: 'amber' };
    case SubscriptionStatus.Canceled:
      return { label: 'Canceled', tone: 'red' };
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

  // The enum, for an account Stripe has not named. A quote negotiated in Stripe
  // is none of its values, so it answers only where it can.
  switch (subscription.planId) {
    case PlanId.FreeTrial:
      return 'Free trial';
    case PlanId.PayAsYouGo:
      return 'Pay as you go';
    case PlanId.Manual:
      return 'Custom plan';
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
 *
 * Nothing at all while trialing, even when Stripe already attached a price to
 * the subscription it will become: nobody is charged that rate yet, and the
 * usage card right below this one already states the trial's own storage and
 * egress limits, so repeating either fact here is redundant at best and, for
 * the rate, reads as a bill that has not started.
 */
export function pricingLine(subscription: Subscription): string {
  const { pricePerTbCents, status } = subscription;

  if (status === SubscriptionStatus.Trialing) return '';
  if (status === SubscriptionStatus.Manual) return 'Billed manually';
  if (pricePerTbCents) return `${formatCents(pricePerTbCents)}/TB per month`;
  if (status === SubscriptionStatus.Inactive) return 'Choose a plan to start storing data';

  return 'Custom pricing';
}

/**
 * A date as "Nov 11" when it falls in the current year and "Jan 5, 2027" when
 * not. Years compared in local time, the zone both formatters display in, so
 * the rule and the text agree across New Year's Eve.
 */
function formatEndDate(isoString: string, now: Date): string {
  return new Date(isoString).getFullYear() === now.getFullYear()
    ? formatMonthDay(isoString)
    : formatDate(isoString);
}

/**
 * The discounts that still come off an invoice: those on a subscription that
 * is running, or retrying a failed payment. Stripe can keep a discount on a
 * subscription after it is canceled, and a grace period starts with that
 * cancellation, so neither shows one: it would advertise a saving on a bill
 * that is not coming, and reactivating starts a new subscription without it.
 */
export function getAppliedDiscounts(subscription: Subscription): SubscriptionDiscount[] {
  const { status, discounts = [] } = subscription;
  return status === SubscriptionStatus.Active || status === SubscriptionStatus.PastDue
    ? discounts
    : [];
}

/**
 * The per-TB rate after the discounts that change it, or null when none do.
 *
 * Only a percentage that keeps applying (for some months, or for good) changes
 * the rate: a fixed amount comes off the invoice, not each TB, and a one-off
 * discount comes off the next invoice only, so "per month" would overstate it.
 * Those stay in words on the detail line, and the rate stays as listed.
 * Taken off the same way as the estimate's discounts (`applyDiscounts`), so
 * the two cannot disagree.
 */
export function getDiscountedRateCents(subscription: Subscription): number | null {
  const { pricePerTbCents } = subscription;
  if (!pricePerTbCents) return null;

  const rateDiscounts = getAppliedDiscounts(subscription).filter(
    (discount) => 'percentOff' in discount && discount.duration !== 'once',
  );
  if (rateDiscounts.length === 0) return null;
  return applyDiscounts(pricePerTbCents, rateDiscounts);
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

  // No "Trial" subject: the plan name and the pill beside it already say
  // it's a trial, and this line's job is just the deadline.
  if (status === SubscriptionStatus.Trialing && trialEndsAt) {
    return endsInLabel(undefined, trialEndsAt);
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
 * "Access ends in 12 days", or plain "Ends in 12 days" with no `subject` —
 * the last day of it spelled out rather than counted: `daysUntil` clamps at
 * zero, so 0 is later today, not gone.
 */
function endsInLabel(subject: string | undefined, iso: string): string {
  const days = daysUntil(iso);
  const prefix = subject ? `${subject} ends` : 'Ends';
  return days === 0 ? `${prefix} today` : `${prefix} in ${pluralizeDays(days)}`;
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
  return formatDaysLeft(daysUntil(subscription.currentPeriodEnd));
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
  | { kind: 'estimate'; cents: number; minimumApplied: boolean; discounted: boolean }
  | { kind: 'agreement' }
  | { kind: 'none' };

export function costDisclosure(
  subscription: Subscription,
  storageBytesUsed: number,
): CostDisclosure {
  if (!isBilling(subscription.status)) return { kind: 'none' };

  const { pricePerTbCents, monthlyMinimumCents = 0 } = subscription;
  if (!pricePerTbCents) return { kind: 'agreement' };
  const discounts = getAppliedDiscounts(subscription);

  const usageCents = Math.round((storageBytesUsed / TB_BYTES) * pricePerTbCents);
  // The minimum is part of the subtotal Stripe discounts, so the floor comes
  // first and the discounts are taken off what it leaves.
  const subtotalCents = Math.max(usageCents, monthlyMinimumCents);
  return {
    kind: 'estimate',
    cents: applyDiscounts(subtotalCents, discounts),
    minimumApplied: monthlyMinimumCents > usageCents,
    discounted: discounts.length > 0,
  };
}

/**
 * A subtotal after each discount, taken in the order Stripe applies them, each
 * on what the one before it left. Never below zero: a fixed amount larger than
 * the bill makes it free, not a credit.
 */
function applyDiscounts(subtotalCents: number, discounts: SubscriptionDiscount[]): number {
  return discounts.reduce((cents, discount) => {
    const off =
      'percentOff' in discount
        ? Math.round((cents * discount.percentOff) / 100)
        : discount.amountOffCents;
    return Math.max(0, cents - off);
  }, subtotalCents);
}

/**
 * The note beside an estimate the discounts went into: "Including 20%
 * discount". Only the amount, not how long it lasts: the plan card says that,
 * and here it would crowd the figure. Several discounts are not added up into
 * one percentage, which would be wrong, so they are just named as discounts.
 */
export function estimateDiscountNote(discounts: SubscriptionDiscount[] = []): string | null {
  const [only, ...others] = discounts;
  if (!only) return null;
  if (others.length > 0) return 'Including discounts';
  const amount = 'percentOff' in only ? `${only.percentOff}%` : formatCents(only.amountOffCents);
  return `Including ${amount} discount`;
}

/**
 * What a discount takes off and for how long, in one phrase: "20% off for 3
 * months", "$10.00 off your next invoice".
 *
 * A discount already on the subscription carries the date it ends, which is
 * the more useful fact once it is running. One checked before it is applied
 * has no start yet, so it can only say how many months it lasts. The end date
 * leaves out the year when it is this year ("until Nov 11"), and states it
 * when it is not, where "until Jan 5" alone could mean either year.
 */
export function discountLabel(discount: SubscriptionDiscount, now: Date = new Date()): string {
  const amount =
    'percentOff' in discount ? `${discount.percentOff}%` : formatCents(discount.amountOffCents);

  switch (discount.duration) {
    case 'once':
      return `${amount} off your next invoice`;
    case 'forever':
      return `${amount} off every invoice`;
    case 'repeating':
      if (discount.endsAt) return `${amount} off until ${formatEndDate(discount.endsAt, now)}`;
      if (discount.durationInMonths) {
        const months = discount.durationInMonths;
        return `${amount} off for ${months} ${months === 1 ? 'month' : 'months'}`;
      }
      return `${amount} off`;
  }
}

/** The states where an invoice is being run up, so a cost line means something. */
function isBilling(status: SubscriptionStatus): boolean {
  return (
    status === SubscriptionStatus.Active ||
    status === SubscriptionStatus.Manual ||
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

/**
 * Stripe's `card.brand` IDs, by the names the networks use for themselves.
 * Capitalising the ID gave "Jcb", "Unionpay" and "Eftpos_au".
 */
const CARD_BRAND_NAMES: Record<string, string> = {
  amex: 'American Express',
  cartes_bancaires: 'Cartes Bancaires',
  diners: 'Diners Club',
  discover: 'Discover',
  eftpos_au: 'eftpos',
  jcb: 'JCB',
  link: 'Link',
  mastercard: 'Mastercard',
  unionpay: 'UnionPay',
  visa: 'Visa',
};

/**
 * What a saved card is called: "Visa", "American Express". "Card" for a brand
 * Stripe could not name, or one it adds before this list does.
 */
export function getCardBrandName(brand: string): string {
  const key = brand.toLowerCase();
  return Object.hasOwn(CARD_BRAND_NAMES, key) ? CARD_BRAND_NAMES[key] : 'Card';
}
