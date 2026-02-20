export type PlanId = 'free_trial' | 'pay_as_you_go' | 'starter' | 'pro'

export interface Plan {
  id: PlanId
  name: string
  description: string
  storageLimitBytes: number
  downloadLimitBytes: number
  pricePerTibCents: number
  flatPriceCents?: number
  features: string[]
}

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled'

export interface Subscription {
  planId: PlanId
  status: SubscriptionStatus
  trialEndsAt?: string
  currentPeriodEnd?: string
}

export interface PaymentMethod {
  id: string
  last4: string
  brand: string
  expMonth: number
  expYear: number
}

export interface BillingInfo {
  subscription: Subscription
  paymentMethod?: PaymentMethod
  plans: Plan[]
}

// UNKNOWN: Payment processor token format. Defaulting to a generic tokenized approach (e.g. Stripe PaymentMethod ID).
export interface AddPaymentMethodRequest {
  paymentMethodToken: string
}

export interface AddPaymentMethodResponse {
  paymentMethod: PaymentMethod
}

export interface ChangePlanRequest {
  planId: PlanId
}

export interface ChangePlanResponse {
  subscription: Subscription
}
