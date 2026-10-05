import { SubscriptionStatus } from '@filone/shared';

/**
 * Values written to the HubSpot contact property `filone_subscription_status`
 * (FIL-828). Lifecycle values for marketing ops, not a passthrough of Stripe's
 * or our own status enums — ops needs to answer "may this person receive a
 * data-deletion warning?". The deletion sequence enrols only on `trialing` and
 * `lapsed`, so every other value is an exit.
 */
export const HubSpotLifecycleStatus = {
  /** Card charged; the deletion sequence excludes this value. */
  Paying: 'paying',
  /** Free trial, no payment taken yet. */
  Trialing: 'trialing',
  /** Card declining but Stripe is still retrying — they are trying to pay. */
  PaymentFailing: 'payment_failing',
  /** Subscription gone; the countdown to data deletion has started. */
  Lapsed: 'lapsed',
  /** Unrecognised state; excluded from the sequence, so it fails safe. */
  Unknown: 'unknown',
} as const;
export type HubSpotLifecycleStatus =
  (typeof HubSpotLifecycleStatus)[keyof typeof HubSpotLifecycleStatus];

/**
 * Maps our internal `SubscriptionStatus` to the HubSpot lifecycle vocabulary.
 *
 * Total by design: `null`/`undefined` — what `mapStripeStatus` returns for
 * `incomplete` and for any status Stripe adds later — becomes `Unknown` rather
 * than leaving the property stale. A contact still holding `trialing` after its
 * subscription moved on is how a paying customer receives a deletion warning.
 *
 * `PastDue` and `GracePeriod` diverge here even though `subscription-guard`
 * treats them identically: past_due is still being retried by Stripe, while
 * grace_period is a deletion countdown.
 */
export function fromInternalStatus(
  status: SubscriptionStatus | null | undefined,
): HubSpotLifecycleStatus {
  switch (status) {
    case SubscriptionStatus.Active:
      return HubSpotLifecycleStatus.Paying;
    case SubscriptionStatus.Trialing:
      return HubSpotLifecycleStatus.Trialing;
    case SubscriptionStatus.PastDue:
      return HubSpotLifecycleStatus.PaymentFailing;
    case SubscriptionStatus.GracePeriod:
    case SubscriptionStatus.Canceled:
    case SubscriptionStatus.Inactive:
      return HubSpotLifecycleStatus.Lapsed;
    default:
      return HubSpotLifecycleStatus.Unknown;
  }
}
