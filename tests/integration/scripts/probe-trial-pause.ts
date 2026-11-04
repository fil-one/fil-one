// Probe: can a Fil One trial (metered price) pause at or after trial end?
//
// Runs against the Stripe sandbox the stage is configured with. Every customer
// it creates is deleted at the end, which deletes its subscriptions too.
//
//   AWS_PROFILE=hyperspace AWS_REGION=us-east-1 pnpm exec sst shell --stage srdjan -- \
//     node tests/integration/scripts/probe-trial-pause.ts

import Stripe from 'stripe';
import { Resource } from 'sst';

const stripe = new Stripe(Resource.StripeSecretKey.value);
const priceId = Resource.StripePriceId.value;
const customers: string[] = [];

if (!Resource.StripeSecretKey.value.startsWith('sk_test_')) {
  throw new Error('Refusing to run: the stage is not configured with a Stripe test key');
}

async function newCustomer(): Promise<string> {
  const { id } = await stripe.customers.create({ metadata: { probe: 'fil-1545-trial-pause' } });
  customers.push(id);
  return id;
}

async function attempt(label: string, fn: () => Promise<string>): Promise<void> {
  try {
    console.log(`OK    ${label}: ${await fn()}`);
  } catch (err) {
    console.log(`ERROR ${label}: ${(err as Error).message}`);
  }
}

const trialEnd = () => Math.floor(Date.now() / 1000) + 24 * 60 * 60;

try {
  const price = await stripe.prices.retrieve(priceId);
  console.log('price', {
    id: price.id,
    usage_type: price.recurring?.usage_type,
    meter: price.recurring?.meter,
    interval: price.recurring?.interval,
  });

  // 1. Stripe pauses the subscription itself at trial end.
  for (const billingMode of [undefined, 'flexible', 'classic'] as const) {
    await attempt(
      `create trial with pause at trial end (billing_mode ${billingMode ?? 'default'})`,
      async () => {
        const sub = await stripe.subscriptions.create({
          customer: await newCustomer(),
          items: [{ price: priceId }],
          trial_end: trialEnd(),
          trial_settings: { end_behavior: { missing_payment_method: 'pause' } },
          ...(billingMode ? { billing_mode: { type: billingMode } } : {}),
        });
        return `${sub.status}, billing_mode ${sub.billing_mode.type}`;
      },
    );
  }

  // 2. Pause a subscription while it is still trialing.
  const trialing = await stripe.subscriptions.create({
    customer: await newCustomer(),
    items: [{ price: priceId }],
    trial_end: trialEnd(),
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
  });
  console.log('trialing subscription billing_mode', trialing.billing_mode.type);
  await attempt('pause a trialing subscription', async () => {
    const paused = await stripe.subscriptions.pause(trialing.id);
    return paused.status;
  });

  // 3. End the trial with no card, then pause, then resume once a card is added.
  //    Ending a trial set to cancel without a card cancels it, so this one invoices.
  for (const endBehavior of ['cancel', 'create_invoice'] as const) {
    const sub = await stripe.subscriptions.create({
      customer: await newCustomer(),
      items: [{ price: priceId }],
      trial_end: trialEnd(),
      trial_settings: { end_behavior: { missing_payment_method: endBehavior } },
    });
    await attempt(`[${endBehavior}] end trial with no card`, async () => {
      const ended = await stripe.subscriptions.update(sub.id, {
        trial_end: 'now',
        expand: ['latest_invoice'],
      });
      const invoice = ended.latest_invoice as Stripe.Invoice | null;
      return `${ended.status}, latest invoice ${invoice?.status} for ${invoice?.amount_due}`;
    });
    await attempt(`[${endBehavior}] pause after ending the trial`, async () => {
      const paused = await stripe.subscriptions.pause(sub.id, {
        bill_for: { outstanding_usage_through: { type: 'none' } },
      });
      return paused.status;
    });
    await attempt(`[${endBehavior}] resume after adding a card`, async () => {
      const pm = await stripe.paymentMethods.attach('pm_card_visa', {
        customer: sub.customer as string,
      });
      await stripe.subscriptions.update(sub.id, { default_payment_method: pm.id });
      const resumed = await stripe.subscriptions.resume(sub.id, {
        billing_cycle_anchor: { type: 'now' },
        payment_behavior: 'resume_on_payment_success',
      });
      return resumed.status;
    });
  }
} finally {
  for (const id of customers) await stripe.customers.del(id);
  console.log(`deleted ${customers.length} probe customers`);
}
