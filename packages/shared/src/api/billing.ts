import { z } from 'zod';

export const ActivateSubscriptionRequestSchema = z
  .object({
    useSavedPaymentMethod: z.boolean().default(false),
    promotionCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{3,40}$/, 'Promo code must be 3–40 letters, digits, or hyphens.')
      .optional(),
  })
  .strict();

export type ActivateSubscriptionRequest = z.input<typeof ActivateSubscriptionRequestSchema>;

export const PlanId = {
  FreeTrial: 'free_trial',
  PayAsYouGo: 'pay_as_you_go',
  /**
   * Read-model value only: reported by `GET /api/billing` when the account has
   * no entitlement (no billing record, or a record without a subscription
   * status). Never persisted to DynamoDB.
   */
  None: 'none',
} as const;
export type PlanId = (typeof PlanId)[keyof typeof PlanId];

export const SubscriptionStatus = {
  Trialing: 'trialing',
  Active: 'active',
  PastDue: 'past_due',
  Canceled: 'canceled',
  GracePeriod: 'grace_period',
  /**
   * Read-model value only: the subscription-guard denies these accounts with
   * `SUBSCRIPTION_INACTIVE`, and `GET /api/billing` reports the same state
   * instead of synthesizing a trial. Never persisted to DynamoDB and never
   * returned by `mapStripeStatus`.
   */
  Inactive: 'inactive',
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export interface Plan {
  id: PlanId;
  name: string;
  description: string;
  storageLimitBytes: number;
  pricePerTbCents: number;
  features: string[];
}

export interface Subscription {
  planId: PlanId;
  status: SubscriptionStatus;
  trialEndsAt?: string;
  /**
   * When the period being billed began. Absent on accounts whose record predates
   * it being stored, so a console showing the period has to tolerate having only
   * the end date.
   */
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  canceledAt?: string;
  gracePeriodEndsAt?: string;
  /**
   * Per-org monthly billing minimum in cents (e.g. 499 for the $4.99/month
   * minimum on the current pay-as-you-go plan). Absent or 0 means the org has
   * no minimum — including customers grandfathered on pre-minimum pricing. Set
   * by the backend from the org's Stripe plan, which is the source of truth for
   * what is actually billed.
   */
  monthlyMinimumCents?: number;
  /**
   * What the customer's plan is called, taken from the Stripe product the
   * subscription is billed on (`Business`, `Pay as you go`, whatever sales
   * named it). Absent when Stripe could not be reached and nothing was cached,
   * and for an account with no subscription at all.
   *
   * Reported rather than inferred from `planId`: `planId` has three values and
   * a negotiated quote is none of them, so a console reading the enum would
   * call every paying customer "Pay as you go" — including the ones on a
   * contract that says otherwise.
   */
  planName?: string;
  /**
   * The exact usage rate, per TB per month, when the billed price states one
   * unambiguously: a per-unit price, or a graduated price whose usage tiers all
   * share a rate (the shape self-serve is on).
   *
   * Absent when no single number would be true — volume tiering, or graduated
   * tiers that step, which is where a negotiated quote usually lands. A console
   * with no rate shows none and points at the agreement, which is the point:
   * the alternative is the list price standing in for what somebody is
   * actually billed.
   *
   * Deliberately no companion "is this a custom deal" flag. The only honest
   * source for one would be the configured self-serve price id, and that id
   * changes whenever pricing is rotated — which would relabel every existing
   * self-serve account as contracted. What is billed is a fact; who negotiated
   * it is not something this endpoint can know.
   */
  pricePerTbCents?: number;
}

export interface PaymentMethod {
  id: string;
  last4: string;
  brand: string;
  expMonth: number;
  expYear: number;
}

export interface BillingInfo {
  subscription: Subscription;
  paymentMethod?: PaymentMethod;
}

export interface CreateSetupIntentResponse {
  clientSecret: string;
  stripePublishableKey: string;
}

export interface ActivateSubscriptionResponse {
  subscription: Subscription;
}

export interface CreatePortalSessionResponse {
  url: string;
}

export interface Invoice {
  id: string;
  amountDueInCents: number;
  status: 'paid' | 'open' | 'void' | 'draft' | 'uncollectible' | 'unknown';
  createdAt: string;
  invoicePdfUrl: string | null;
}

export interface ListInvoicesResponse {
  invoices: Invoice[];
}

/**
 * Maps a raw Stripe subscription status to our internal SubscriptionStatus enum.
 * Returns the mapped status, or null if the Stripe status represents a
 * non-functional state that should not be persisted (e.g. incomplete).
 */

export function mapStripeStatus(stripeStatus: string): SubscriptionStatus | null {
  switch (stripeStatus) {
    case 'active':
      return SubscriptionStatus.Active;
    case 'trialing':
      return SubscriptionStatus.Trialing;
    case 'past_due':
      return SubscriptionStatus.PastDue;
    case 'canceled':
      return SubscriptionStatus.Canceled;
    case 'unpaid':
    case 'paused':
      return SubscriptionStatus.PastDue;
    case 'incomplete_expired':
      return SubscriptionStatus.Canceled;
    case 'incomplete':
    default:
      return null;
  }
}
