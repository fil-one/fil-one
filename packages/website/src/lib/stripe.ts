import type { Stripe } from '@stripe/stripe-js';

let stripePromise: Promise<Stripe | null> | null = null;

export function getStripe(publishableKey: string): Promise<Stripe | null> {
  if (!stripePromise) {
    if (!publishableKey) {
      console.warn('[stripe] No Stripe publishable key provided');
      return Promise.resolve(null);
    }
    // Dynamic import so stripe-js is only loaded when billing is actually used
    stripePromise = import('@stripe/stripe-js').then((m) => m.loadStripe(publishableKey));
  }
  return stripePromise;
}
