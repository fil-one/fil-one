import type { Stripe } from '@stripe/stripe-js';
import { STRIPE_PUBLISHABLE_KEY } from '../env.js';

let stripePromise: Promise<Stripe | null> | null = null;

export function getStripe(): Promise<Stripe | null> {
  if (!stripePromise) {
    if (!STRIPE_PUBLISHABLE_KEY) {
      console.warn('[stripe] VITE_STRIPE_PUBLISHABLE_KEY is not set');
      return Promise.resolve(null);
    }
    // Dynamic import so stripe-js is only loaded when billing is actually used
    stripePromise = import('@stripe/stripe-js').then((m) => m.loadStripe(STRIPE_PUBLISHABLE_KEY));
  }
  return stripePromise;
}
