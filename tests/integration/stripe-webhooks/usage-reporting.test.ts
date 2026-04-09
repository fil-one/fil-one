import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  createTestCustomer,
  attachValidCard,
  getStripePriceId,
  getStripeClient,
  sleep,
  pollTestClockReady,
  deleteBillingRecord,
} from './helpers.js';

describe('Usage Reporting (meter events via test clock)', () => {
  let userId: string;
  let cusId: string;
  let clockId: string;
  let subId: string;

  beforeAll(async () => {
    userId = `test-ur-${crypto.randomUUID()}`;
    const stripe = getStripeClient();
    const priceId = getStripePriceId();

    // Create test clock anchored at now
    const frozenTime = Math.floor(Date.now() / 1000);
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: frozenTime,
      name: `usage-reporting-test-${crypto.randomUUID()}`,
    });
    clockId = clock.id;

    // Create customer on test clock
    cusId = await createTestCustomer(userId, clockId);

    // Attach valid card
    const pmId = await attachValidCard(cusId);

    // Create active subscription with metered price
    const anchorTime = frozenTime + 7 * 86400;
    const sub = await stripe.subscriptions.create({
      customer: cusId,
      items: [{ price: priceId }],
      default_payment_method: pmId,
      billing_cycle_anchor: anchorTime,
      proration_behavior: 'none',
      metadata: { userId, orgId: 'test-org' },
    });
    subId = sub.id;
  });

  afterAll(async () => {
    const stripe = getStripeClient();
    await stripe.subscriptions.cancel(subId);
    // deleting the clock will also delete associated customers
    await stripe.testHelpers.testClocks.del(clockId);
    await deleteBillingRecord(userId);
  });

  it('should create an invoice with metered line item after clock advance', async () => {
    const stripe = getStripeClient();
    const priceId = getStripePriceId();

    // Retrieve subscription to get period end
    const sub = await stripe.subscriptions.retrieve(subId);
    const periodEnd =
      (sub.items.data[0] as unknown as Record<string, unknown>)?.current_period_end ??
      (sub as unknown as Record<string, unknown>).current_period_end ??
      null;

    // Resolve the meter event name from the price's linked meter
    const price = await stripe.prices.retrieve(priceId);
    const meterId = (price.recurring as unknown as Record<string, string>)?.meter;
    const meter = await stripe.billing.meters.retrieve(meterId);
    const meterEventName = meter.event_name;

    // Send meter event
    await stripe.billing.meterEvents.create({
      event_name: meterEventName,
      payload: {
        value: '1337',
        stripe_customer_id: cusId,
      },
    });

    // Wait for meter event ingestion
    await sleep(15 * 1000);

    // Advance test clock past period end
    const frozenTime = Math.floor(Date.now() / 1000);
    const advanceTo = periodEnd ? Number(periodEnd) + 3600 : frozenTime + 31 * 86400;
    await stripe.testHelpers.testClocks.advance(clockId, {
      frozen_time: advanceTo,
    });

    // Poll until clock is ready
    await pollTestClockReady({ clockId, timeoutSeconds: 120 });

    // Fetch invoices and check for metered line item
    const invoices = await stripe.invoices.list({
      customer: cusId,
      limit: 10,
    });

    let foundUsage = false;
    for (const inv of invoices.data) {
      const lines = await stripe.invoices.listLineItems(inv.id, {
        limit: 100,
      });

      for (const line of lines.data) {
        const lineRecord = line as unknown as Record<string, unknown>;
        const pricing = lineRecord.pricing as Record<string, Record<string, unknown>> | undefined;
        const linePrice = lineRecord.price;
        const linePriceId =
          pricing?.price_details?.price ??
          (typeof linePrice === 'object'
            ? (linePrice as Record<string, unknown> | null)?.id
            : linePrice) ??
          '';
        if (linePriceId === priceId) {
          foundUsage = true;
          break;
        }
      }
      if (foundUsage) break;
    }

    expect(foundUsage).toBe(true);
  }, 300_000);
});
