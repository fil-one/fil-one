import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import Stripe from 'stripe';
import { getEnv } from './env.js';

interface BillingSecrets {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_ID: string;
}

// Module-level cache — reused across Lambda warm starts
const smClient = new SecretsManagerClient({});
let cachedSecrets: BillingSecrets | null = null;
let cachedStripe: Stripe | null = null;

export async function getBillingSecrets(): Promise<BillingSecrets> {
  if (cachedSecrets) return cachedSecrets;
  const result = await smClient.send(
    new GetSecretValueCommand({ SecretId: getEnv('BILLING_SECRET_NAME') }),
  );
  cachedSecrets = JSON.parse(result.SecretString ?? '{}') as BillingSecrets;
  return cachedSecrets;
}

export async function getStripeClient(): Promise<Stripe> {
  if (cachedStripe) return cachedStripe;
  const secrets = await getBillingSecrets();
  cachedStripe = new Stripe(secrets.STRIPE_SECRET_KEY);
  return cachedStripe;
}
