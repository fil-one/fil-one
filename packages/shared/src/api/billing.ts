export enum PlanId {
  FreeTrial = 'free_trial',
  PayAsYouGo = 'pay_as_you_go',
}

export enum SubscriptionStatus {
  Trialing = 'trialing',
  Active = 'active',
  PastDue = 'past_due',
  Canceled = 'canceled',
  GracePeriod = 'grace_period',
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
