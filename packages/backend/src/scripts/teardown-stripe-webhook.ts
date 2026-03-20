import Stripe from 'stripe';
import { SSMClient, DeleteParameterCommand } from '@aws-sdk/client-ssm';

interface TeardownOpts {
  stripeSecretKey: string;
  siteUrl: string;
  stage: string;
}

export async function teardownStripeWebhook(opts: TeardownOpts): Promise<void> {
  const { stripeSecretKey, siteUrl, stage } = opts;
  const webhookUrl = `${siteUrl}/api/stripe/webhook`;

  try {
    const stripe = new Stripe(stripeSecretKey);
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    const existing = endpoints.data.find((ep) => ep.url === webhookUrl);

    if (existing) {
      await stripe.webhookEndpoints.del(existing.id);
      console.log(`Deleted Stripe webhook endpoint ${existing.id}`);
    }
  } catch (err) {
    console.warn('Failed to clean up Stripe webhook endpoint:', err);
  }

  try {
    const ssm = new SSMClient({});
    await ssm.send(new DeleteParameterCommand({ Name: `/filone/${stage}/stripe-webhook-secret` }));
    console.log(`Deleted SSM parameter /filone/${stage}/stripe-webhook-secret`);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ParameterNotFound') return;
    console.warn('Failed to delete SSM parameter:', err);
  }
}

// ── CLI entry point ──────────────────────────────────────────────────────

const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMainModule) {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const siteUrl = process.env.SITE_URL;
  const stage = process.env.STAGE;

  if (!stripeSecretKey || !siteUrl || !stage) {
    console.error('Required env vars: STRIPE_SECRET_KEY, SITE_URL, STAGE');
    process.exit(1);
  }

  await teardownStripeWebhook({ stripeSecretKey, siteUrl, stage });
  console.log('Teardown complete');
}
