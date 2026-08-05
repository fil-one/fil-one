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

export enum PlanId {
  FreeTrial = 'free_trial',
  PayAsYouGo = 'pay_as_you_go',
  /**
   * Read-model value only: reported by `GET /api/billing` when the account has
   * no entitlement (no billing record, or a record without a subscription
   * status). Never persisted to DynamoDB.
   */
  None = 'none',
}

export enum SubscriptionStatus {
  Trialing = 'trialing',
  Active = 'active',
  PastDue = 'past_due',
  Canceled = 'canceled',
  GracePeriod = 'grace_period',
  /**
   * Read-model value only: the subscription-guard denies these accounts with
   * `SUBSCRIPTION_INACTIVE`, and `GET /api/billing` reports the same state
   * instead of synthesizing a trial. Never persisted to DynamoDB and never
   * returned by `mapStripeStatus`.
   */
  Inactive = 'inactive',
}

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
