import { Resource } from "sst";
import Stripe from 'stripe';

export interface BillingSecrets {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_ID: string;
}

// Module-level cache — reused across Lambda warm starts
let cachedStripe: Stripe | null = null;

export function getBillingSecrets(): BillingSecrets {
  return {
    STRIPE_SECRET_KEY: Resource.StripeSecretKey.value,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET!,
    STRIPE_PRICE_ID: Resource.StripePriceId.value,
  };
}

export function getStripeClient(): Stripe {
  if (cachedStripe) return cachedStripe;
  cachedStripe = new Stripe(getBillingSecrets().STRIPE_SECRET_KEY);
  return cachedStripe;
}
