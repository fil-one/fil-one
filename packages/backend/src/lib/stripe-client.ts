import { Resource } from 'sst';
import Stripe from 'stripe';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

declare const process: { env: Record<string, string | undefined> };

export interface BillingSecrets {
  STRIPE_SECRET_KEY: string;
  STRIPE_PRICE_ID: string;
}

// Module-level cache — reused across Lambda warm starts
let cachedStripe: Stripe | null = null;
let cachedWebhookSecret: string | null = null;

const ssm = new SSMClient({});

export function getBillingSecrets(): BillingSecrets {
  return {
    STRIPE_SECRET_KEY: Resource.StripeSecretKey.value,
    STRIPE_PRICE_ID: Resource.StripePriceId.value,
  };
}

export async function getWebhookSecret(): Promise<string> {
  if (cachedWebhookSecret) return cachedWebhookSecret;
  const result = await ssm.send(
    new GetParameterCommand({
      Name: process.env.STRIPE_WEBHOOK_SECRET_SSM_PATH!,
      WithDecryption: true,
    }),
  );
  cachedWebhookSecret = result.Parameter!.Value!;
  return cachedWebhookSecret;
}

export function getStripeClient(): Stripe {
  if (cachedStripe) return cachedStripe;
  cachedStripe = new Stripe(getBillingSecrets().STRIPE_SECRET_KEY);
  return cachedStripe;
}

export async function updateCustomerMetadata(
  customerId: string,
  metadata: Record<string, string>,
): Promise<void> {
  const stripe = getStripeClient();
  await stripe.customers.update(customerId, { metadata });
}

// Stripe SDK errors expose `code` on the error object; matches StripeInvalidRequestError 404s.
export function isStripeResourceMissing(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'resource_missing'
  );
}

export type CustomerExistence = 'deleted' | 'exists' | 'not-in-account';

/**
 * Distinguishes a customer that existed and was deleted from an id this
 * Stripe account has never seen (wrong key/account/mode). Deleted customers
 * stay retrievable as a `deleted: true` stub; only never-existing ids 404.
 * Returns 'exists' when the customer is alive — a resource_missing observed
 * elsewhere for it was transient/anomalous.
 */
export async function getCustomerExistence(customerId: string): Promise<CustomerExistence> {
  const stripe = getStripeClient();
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return 'deleted' in customer && customer.deleted ? 'deleted' : 'exists';
  } catch (err) {
    if (isStripeResourceMissing(err)) return 'not-in-account';
    throw err;
  }
}
