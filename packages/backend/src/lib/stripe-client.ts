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
