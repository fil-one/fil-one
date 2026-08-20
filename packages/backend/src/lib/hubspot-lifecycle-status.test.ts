import { SubscriptionStatus, mapStripeStatus } from '@filone/shared';
import { describe, expect, it } from 'vitest';
import { HubSpotLifecycleStatus, fromInternalStatus } from './hubspot-lifecycle-status.js';

describe('fromInternalStatus', () => {
  it.each([
    [SubscriptionStatus.Active, HubSpotLifecycleStatus.Paying],
    [SubscriptionStatus.Trialing, HubSpotLifecycleStatus.Trialing],
    [SubscriptionStatus.PastDue, HubSpotLifecycleStatus.PaymentFailing],
    [SubscriptionStatus.GracePeriod, HubSpotLifecycleStatus.Lapsed],
    [SubscriptionStatus.Canceled, HubSpotLifecycleStatus.Lapsed],
    [SubscriptionStatus.Inactive, HubSpotLifecycleStatus.Lapsed],
  ])('maps %s to %s', (internalStatus, expected) => {
    expect(fromInternalStatus(internalStatus)).toBe(expected);
  });

  it.each([null, undefined])('maps %s to unknown rather than leaving it undefined', (status) => {
    expect(fromInternalStatus(status)).toBe(HubSpotLifecycleStatus.Unknown);
  });

  it('separates past_due from grace_period, unlike the subscription guard', () => {
    expect(fromInternalStatus(SubscriptionStatus.PastDue)).toBe(
      HubSpotLifecycleStatus.PaymentFailing,
    );
    expect(fromInternalStatus(SubscriptionStatus.GracePeriod)).toBe(HubSpotLifecycleStatus.Lapsed);
  });
});

describe('composed with mapStripeStatus', () => {
  // All eight statuses Stripe documents on the Subscription object, pinned end
  // to end so a change to mapStripeStatus that alters lifecycle meaning fails here.
  it.each([
    ['active', HubSpotLifecycleStatus.Paying],
    ['trialing', HubSpotLifecycleStatus.Trialing],
    ['past_due', HubSpotLifecycleStatus.PaymentFailing],
    ['unpaid', HubSpotLifecycleStatus.PaymentFailing],
    ['paused', HubSpotLifecycleStatus.PaymentFailing],
    ['canceled', HubSpotLifecycleStatus.Lapsed],
    ['incomplete_expired', HubSpotLifecycleStatus.Lapsed],
    // mapStripeStatus returns null here, so it fails safe to do-not-email.
    ['incomplete', HubSpotLifecycleStatus.Unknown],
  ])('maps Stripe %s to %s', (stripeStatus, expected) => {
    expect(fromInternalStatus(mapStripeStatus(stripeStatus))).toBe(expected);
  });

  it.each(['', 'something_stripe_adds_later', 'ACTIVE'])(
    'maps the unrecognised Stripe value %j to unknown',
    (stripeStatus) => {
      expect(fromInternalStatus(mapStripeStatus(stripeStatus))).toBe(
        HubSpotLifecycleStatus.Unknown,
      );
    },
  );
});
