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
  pricePerTibCents: number;
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

export interface UsageInfo {
  storageUsedBytes: number;
  storageLimitBytes: number;
  estimatedMonthlyCostCents: number;
}

export interface BillingInfo {
  subscription: Subscription;
  paymentMethod?: PaymentMethod;
  usage?: UsageInfo;
}

export interface CreateSetupIntentResponse {
  clientSecret: string;
}

export interface ActivateSubscriptionResponse {
  subscription: Subscription;
}

export interface CreatePortalSessionResponse {
  url: string;
}
