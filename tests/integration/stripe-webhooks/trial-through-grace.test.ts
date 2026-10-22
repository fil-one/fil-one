import { describe, it, afterAll, expect } from 'vitest';
import { SubscriptionStatus, TRIAL_GRACE_DAYS } from '@filone/shared';
import { createBillingTrial } from '@filone/backend/src/lib/create-billing-trial.ts';
import { deleteOrgProfile, invokeEnforcer, seedOrgProfile } from '../jobs/helpers.ts';
import {
  createTestCustomer,
  deleteBillingRecord,
  getBillingRecord,
  getStripeClient,
  getStripePriceId,
  pollTestClockReady,
  seedBillingRecord,
  testOrgId,
  waitForEventHandled,
} from './helpers.js';

const DAY_SECONDS = 24 * 60 * 60;

describe('A trial that ends without a card', () => {
  const cleanups: (() => Promise<unknown>)[] = [];

  afterAll(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  it('keeps the Stripe trial running until the grace period after the trial ends', async () => {
    const userId = `test-ttg-create-${crypto.randomUUID()}`;
    const orgId = testOrgId(userId);
    cleanups.push(() => deleteBillingRecord(userId));

    await createBillingTrial({ userId, orgId });

    const row = await getBillingRecord(userId);
    cleanups.push(() => getStripeClient().customers.del(row!.stripeCustomerId.S!));
    const subscription = await getStripeClient().subscriptions.retrieve(row!.subscriptionId.S!);
    const rowTrialEnd = Math.floor(new Date(row!.trialEndsAt.S!).getTime() / 1000);
    expect(subscription).toMatchObject({
      status: 'trialing',
      trial_end: rowTrialEnd + TRIAL_GRACE_DAYS * DAY_SECONDS,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    });
  });

  // The console moves an expired trial into grace on the org's next request;
  // an org nobody uses keeps reading `trialing` until Stripe cancels.
  it.each([
    ['the console moved into grace', SubscriptionStatus.GracePeriod, 'gracePeriodEndsAt', 0],
    ['nobody used since the trial', SubscriptionStatus.Trialing, 'trialEndsAt', 7 * DAY_SECONDS],
  ])(
    'ends canceled at the deadline, without a second grace period, for a row %s',
    async (_case, status, dateAttribute, secondsBeforeDeadline) => {
      const stripe = getStripeClient();
      const userId = `test-ttg-end-${crypto.randomUUID()}`;
      // A clock a day behind, so the deadline Stripe ends the trial at has
      // already passed for the enforcer, which runs on real time.
      const start = Math.floor(Date.now() / 1000) - DAY_SECONDS;
      const { id: clockId } = await stripe.testHelpers.testClocks.create({
        frozen_time: start,
        name: `trial-through-grace-${crypto.randomUUID()}`,
      });
      cleanups.push(() => stripe.testHelpers.testClocks.del(clockId));
      const customerId = await createTestCustomer(userId, clockId);
      const deadline = start + 3600;
      const { id: subscriptionId } = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: getStripePriceId() }],
        trial_end: deadline,
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        metadata: { userId, orgId: testOrgId(userId) },
      });
      await waitForEventHandled('customer.subscription.created', subscriptionId);
      const gracePeriodEndsAt = new Date(deadline * 1000).toISOString();
      await seedOrgProfile(testOrgId(userId), 'e7da8138-c669-4cc0-82ef-253e534be11c');
      await seedBillingRecord(userId, customerId, status, {
        subscriptionId: { S: subscriptionId },
        [dateAttribute]: { S: new Date((deadline - secondsBeforeDeadline) * 1000).toISOString() },
      });
      cleanups.push(
        () => deleteBillingRecord(userId),
        () => deleteOrgProfile(testOrgId(userId)),
      );

      await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: deadline + 3600 });
      await pollTestClockReady({ clockId });
      await waitForEventHandled('customer.subscription.deleted', subscriptionId);

      // The deadline is 7 days after the trial, the moment Stripe ended it. The status may
      // already read canceled: the enforcer integration tests run beside this one
      // and invoke the same enforcer, which acts on every expired row.
      expect((await getBillingRecord(userId))?.gracePeriodEndsAt).toStrictEqual({
        S: gracePeriodEndsAt,
      });

      const result = await invokeEnforcer();

      expect(result.functionError).toBeUndefined();
      expect((await getBillingRecord(userId))?.subscriptionStatus).toStrictEqual({
        S: SubscriptionStatus.Canceled,
      });
    },
    420_000,
  );
});
