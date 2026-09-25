import { describe, it, expect } from 'vitest';
import { PlanId, SubscriptionStatus, TB_BYTES } from '@filone/shared';
import type { Subscription } from '@filone/shared';

import {
  billingPeriodRange,
  costDisclosure,
  daysLeftLabel,
  storageCostCents,
  paymentPosture,
  planTitle,
  pricingLine,
  showsSalesPitch,
  statusBadge,
  timelineLine,
  usageLimits,
} from './billing-view.js';

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    planId: PlanId.PayAsYouGo,
    status: SubscriptionStatus.Active,
    ...overrides,
  };
}

/** The self-serve price as `get-billing` reports it. */
const SELF_SERVE = { pricePerTbCents: 499, monthlyMinimumCents: 499 };

/** A negotiated volume deal: a name, a floor, and no single per-TB rate. */
const CONTRACTED = { planName: 'Business', monthlyMinimumCents: 250_000 };

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe('planTitle', () => {
  it('uses the name Stripe reports, which is what the contract calls it', () => {
    expect(planTitle(subscription({ planName: 'Business' }))).toBe('Business');
  });

  it('names the state, then the plan, when Stripe reported no product', () => {
    expect(planTitle(subscription({ status: SubscriptionStatus.Trialing }))).toBe('Free trial');
    expect(planTitle(subscription({ status: SubscriptionStatus.Inactive }))).toBe('No plan');
    expect(planTitle(subscription())).toBe('Pay as you go');
  });

  it('falls back to a plan somebody is on rather than to "Unknown"', () => {
    // The Dashboard printed "Unknown" for a planId it did not recognise. A label
    // the console cannot fill is still a plan being paid for.
    expect(planTitle(subscription({ planId: 'enterprise' as PlanId }))).toBe('Your plan');
  });

  it('says "Free trial" even when Stripe already named the price it trials into', () => {
    // Stripe attaches the eventual paid price's product name to a trialing
    // subscription too — showing that name here would call an account that
    // has committed to nothing and holds no card on file by the name of a
    // plan it is not yet on.
    expect(
      planTitle(subscription({ status: SubscriptionStatus.Trialing, planName: 'Business' })),
    ).toBe('Free trial');
  });
});

describe('pricingLine', () => {
  it('states the rate, and only the rate', () => {
    // The minimum is deliberately not here: it reads as a second price, and it
    // is said where it actually bites, on the estimate.
    expect(pricingLine(subscription(SELF_SERVE))).toBe('$4.99/TB per month');
    expect(pricingLine(subscription({ pricePerTbCents: 499 }))).toBe('$4.99/TB per month');
  });

  it('says so plainly rather than inventing a rate', () => {
    // The case this whole module exists for: a volume deal has no single per-TB
    // number, so the console must not print one.
    expect(pricingLine(subscription(CONTRACTED))).toBe('Custom pricing');
    expect(pricingLine(subscription({ planName: 'Business' }))).toBe('Custom pricing');
  });

  it('says nothing while trialing, even with a rate already attached', () => {
    // Nobody is charged that rate yet, and the trial usage card already
    // states the storage/egress limits — repeating either here is redundant
    // at best and, for the rate, reads as a bill that has not started.
    expect(pricingLine(subscription({ status: SubscriptionStatus.Trialing }))).toBe('');
    expect(
      pricingLine(subscription({ status: SubscriptionStatus.Trialing, pricePerTbCents: 499 })),
    ).toBe('');
  });

  it('describes what an inactive account needs', () => {
    expect(pricingLine(subscription({ status: SubscriptionStatus.Inactive }))).toBe(
      'Choose a plan to start storing data',
    );
  });
});

describe('timelineLine', () => {
  it('counts down the trial, and says so on its last day — with no "Trial" subject', () => {
    // The plan name and the pill beside it already say it's a trial; this
    // line's job is only the deadline.
    expect(
      timelineLine(
        subscription({ status: SubscriptionStatus.Trialing, trialEndsAt: daysFromNow(12) }),
      ),
    ).toBe('Ends in 12 days');
    expect(
      timelineLine(
        subscription({ status: SubscriptionStatus.Trialing, trialEndsAt: daysFromNow(0) }),
      ),
    ).toBe('Ends today');
  });

  it('counts down the grace period', () => {
    expect(
      timelineLine(
        subscription({
          status: SubscriptionStatus.GracePeriod,
          gracePeriodEndsAt: daysFromNow(1),
        }),
      ),
    ).toBe('Access ends in 1 day');
  });

  it('gives a healthy subscription its renewal date', () => {
    expect(timelineLine(subscription({ currentPeriodEnd: '2026-09-12T00:00:00Z' }))).toMatch(
      /^Renews /,
    );
  });

  it('says nothing rather than guessing when there is no date', () => {
    expect(timelineLine(subscription())).toBeNull();
  });
});

describe('billingPeriodRange', () => {
  it('states the year once, at the far end', () => {
    expect(
      billingPeriodRange(
        subscription({
          currentPeriodStart: daysFromNow(-11),
          currentPeriodEnd: daysFromNow(20),
        }),
      ),
    ).toMatch(/^\w{3} \d+ – \w{3} \d+, \d{4}$/);
  });

  it('keeps both years when the period crosses one', () => {
    expect(
      billingPeriodRange(
        subscription({
          currentPeriodStart: '2025-12-15T00:00:00Z',
          currentPeriodEnd: '2026-01-14T00:00:00Z',
        }),
      ),
    ).toMatch(/^\w{3} \d+, 2025 – \w{3} \d+, 2026$/);
  });

  it('gives nothing when only one end is known', () => {
    // Half a range does not say what it counts from, and the missing end is not
    // something to work out by subtracting a month.
    expect(
      billingPeriodRange(subscription({ currentPeriodEnd: '2026-09-12T00:00:00Z' })),
    ).toBeNull();
    expect(
      billingPeriodRange(subscription({ currentPeriodStart: '2026-08-12T00:00:00Z' })),
    ).toBeNull();
    expect(billingPeriodRange(subscription())).toBeNull();
  });
});

describe('daysLeftLabel', () => {
  it('counts what is left of the period', () => {
    expect(daysLeftLabel(subscription({ currentPeriodEnd: daysFromNow(20) }))).toBe('20 days left');
    expect(daysLeftLabel(subscription({ currentPeriodEnd: daysFromNow(1) }))).toBe('1 day left');
  });

  it('says the period ends today rather than counting no days', () => {
    expect(daysLeftLabel(subscription({ currentPeriodEnd: daysFromNow(0) }))).toBe('Ends today');
  });

  it('says nothing without an end date', () => {
    expect(daysLeftLabel(subscription())).toBeNull();
  });
});

describe('storageCostCents', () => {
  it('gives the storage line its own share of the bill', () => {
    // 3 TB at $4.99 a TB, so the breakdown adds up to the total beside it.
    expect(storageCostCents(subscription(SELF_SERVE), 3 * TB_BYTES)).toBe(1497);
  });

  it('gives nothing where no rate was reported', () => {
    expect(storageCostCents(subscription(CONTRACTED), 40 * TB_BYTES)).toBeNull();
  });

  it('gives nothing while nothing is being billed', () => {
    expect(
      storageCostCents(
        subscription({ ...SELF_SERVE, status: SubscriptionStatus.Trialing }),
        TB_BYTES,
      ),
    ).toBeNull();
  });
});

describe('costDisclosure', () => {
  it('estimates from the reported rate', () => {
    expect(costDisclosure(subscription(SELF_SERVE), 3 * TB_BYTES)).toEqual({
      kind: 'estimate',
      cents: 1497,
      minimumApplied: false,
    });
  });

  it('holds the estimate at the monthly minimum, and says the floor is doing the work', () => {
    expect(costDisclosure(subscription(SELF_SERVE), 0)).toEqual({
      kind: 'estimate',
      cents: 499,
      minimumApplied: true,
    });
  });

  it('refuses to estimate a contracted bill', () => {
    expect(costDisclosure(subscription(CONTRACTED), 40 * TB_BYTES)).toEqual({ kind: 'agreement' });
  });

  it('says nothing at all when nothing is being billed', () => {
    for (const status of [
      SubscriptionStatus.Trialing,
      SubscriptionStatus.Canceled,
      SubscriptionStatus.Inactive,
    ]) {
      expect(costDisclosure(subscription({ ...SELF_SERVE, status }), TB_BYTES)).toEqual({
        kind: 'none',
      });
    }
  });

  it('still owes a past-due account its estimate: the usage happened', () => {
    expect(
      costDisclosure(subscription({ ...SELF_SERVE, status: SubscriptionStatus.PastDue }), TB_BYTES),
    ).toMatchObject({ kind: 'estimate' });
  });
});

describe('usageLimits', () => {
  it('gives a trial the ceiling it actually has', () => {
    const limits = usageLimits(SubscriptionStatus.Trialing);
    expect(limits.storageLimitBytes).toBeGreaterThan(0);
    expect(limits.egressLimitBytes).toBeGreaterThan(0);
  });

  it('gives a paid plan no ceiling, so nothing draws a bar against a made-up one', () => {
    expect(usageLimits(SubscriptionStatus.Active)).toEqual({
      storageLimitBytes: null,
      egressLimitBytes: null,
    });
  });
});

describe('showsSalesPitch', () => {
  it('offers sales to accounts that have not bought yet', () => {
    expect(showsSalesPitch(SubscriptionStatus.Trialing)).toBe(true);
    expect(showsSalesPitch(SubscriptionStatus.Inactive)).toBe(true);
  });

  it('does not pitch a plan at somebody already paying for one', () => {
    expect(showsSalesPitch(SubscriptionStatus.Active)).toBe(false);
    expect(showsSalesPitch(SubscriptionStatus.PastDue)).toBe(false);
    expect(showsSalesPitch(SubscriptionStatus.GracePeriod)).toBe(false);
    expect(showsSalesPitch(SubscriptionStatus.Canceled)).toBe(false);
  });
});

describe('paymentPosture', () => {
  const card = { id: 'pm_1', last4: '4242', brand: 'visa', expMonth: 7, expYear: 2031 };

  it('reads a card as a card', () => {
    expect(paymentPosture({ subscription: subscription(), paymentMethod: card })).toBe('card');
  });

  it('reads a billed account with no card as invoiced, not as broken', () => {
    expect(paymentPosture({ subscription: subscription(CONTRACTED) })).toBe('invoiced');
  });

  it('asks a trial for a card, because it will need one', () => {
    expect(
      paymentPosture({ subscription: subscription({ status: SubscriptionStatus.Trialing }) }),
    ).toBe('needs-card');
  });
});

describe('statusBadge', () => {
  it('gives every status a label and a tone', () => {
    for (const status of Object.values(SubscriptionStatus)) {
      const badge = statusBadge(status);
      expect(badge.label).not.toBe('');
      expect(badge.tone).toBeTruthy();
    }
  });

  it('reads past due as a payment problem, not as a cancellation', () => {
    expect(statusBadge(SubscriptionStatus.PastDue)).toEqual({
      label: 'Payment failed',
      tone: 'amber',
      dot: false,
    });
  });
});
