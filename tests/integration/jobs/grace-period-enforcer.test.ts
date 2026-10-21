import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SubscriptionStatus } from '@filone/shared';
import { seedBillingRecord, getBillingRecord, deleteBillingRecord } from '../helpers.ts';
import {
  attachValidCard,
  createSubscription,
  createTestClock,
  createTestCustomer,
  getStripeClient,
  getStripePriceId,
  pollTestClockReady,
  testOrgId,
  waitForEventHandled,
} from '../stripe-webhooks/helpers.ts';
import { invokeEnforcer, seedOrgProfile, deleteOrgProfile } from './helpers.ts';

function pastDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function futureDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

// =============================================================================
// 1. Expired grace period → canceled + DISABLED
// =============================================================================
describe('expired grace period → canceled + DISABLED', () => {
  const userId = `enforcer-grace-${crypto.randomUUID().slice(0, 8)}`;
  const orgId = `org-grace-${crypto.randomUUID().slice(0, 8)}`;
  const tenantId = 'e7da8138-c669-4cc0-82ef-253e534be11c';

  beforeAll(async () => {
    await seedOrgProfile(orgId, tenantId);
    await seedBillingRecord(userId, 'cus_fake_grace', SubscriptionStatus.GracePeriod, {
      orgId: { S: orgId },
      gracePeriodEndsAt: { S: pastDate(1) },
      canceledAt: { S: pastDate(31) },
    });
  });

  afterAll(async () => {
    await deleteBillingRecord(userId, orgId);
    await deleteOrgProfile(orgId);
  });

  it('transitions an expired grace period to canceled', async () => {
    const result = await invokeEnforcer();
    expect(result.functionError).toBeUndefined();

    const record = await getBillingRecord(userId, orgId);
    expect(record).not.toBeNull();
    expect(record!.subscriptionStatus?.S).toBe(SubscriptionStatus.Canceled);
  });
});

// =============================================================================
// 2. Active grace period → no status change, WRITE_LOCK applied
// =============================================================================
describe('active grace period → WRITE_LOCK applied', () => {
  const userId = `enforcer-active-${crypto.randomUUID().slice(0, 8)}`;
  const orgId = `org-active-${crypto.randomUUID().slice(0, 8)}`;
  const tenantId = 'e7da8138-c669-4cc0-82ef-253e534be11c';

  beforeAll(async () => {
    await seedOrgProfile(orgId, tenantId);
    await seedBillingRecord(userId, 'cus_fake_active', SubscriptionStatus.GracePeriod, {
      orgId: { S: orgId },
      gracePeriodEndsAt: { S: futureDate(10) },
      canceledAt: { S: pastDate(5) },
    });
  });

  afterAll(async () => {
    await deleteBillingRecord(userId, orgId);
    await deleteOrgProfile(orgId);
  });

  it('keeps an active grace period in grace_period status', async () => {
    const result = await invokeEnforcer();
    expect(result.functionError).toBeUndefined();

    const record = await getBillingRecord(userId, orgId);
    expect(record).not.toBeNull();
    expect(record!.subscriptionStatus?.S).toBe(SubscriptionStatus.GracePeriod);
  });
});

// =============================================================================
// 3. Mixed batch — only expired records transition to canceled
// =============================================================================
describe('mixed batch — only expired records get canceled', () => {
  const expiredUserId = `enforcer-mix-exp-${crypto.randomUUID().slice(0, 8)}`;
  const activeUserId = `enforcer-mix-act-${crypto.randomUUID().slice(0, 8)}`;
  // Two accounts, so two orgs. They shared one before, which read as a single
  // org holding two subscriptions — the collision the enforcer now resolves to
  // one candidate, and the batch this case is about is two separate tenants.
  const expiredOrgId = `org-mix-exp-${crypto.randomUUID().slice(0, 8)}`;
  const activeOrgId = `org-mix-act-${crypto.randomUUID().slice(0, 8)}`;
  const tenantId = 'e7da8138-c669-4cc0-82ef-253e534be11c';

  beforeAll(async () => {
    await seedOrgProfile(expiredOrgId, tenantId);
    await seedOrgProfile(activeOrgId, tenantId);
    await seedBillingRecord(expiredUserId, 'cus_fake_exp', SubscriptionStatus.GracePeriod, {
      orgId: { S: expiredOrgId },
      gracePeriodEndsAt: { S: pastDate(2) },
      canceledAt: { S: pastDate(32) },
    });
    await seedBillingRecord(activeUserId, 'cus_fake_act', SubscriptionStatus.GracePeriod, {
      orgId: { S: activeOrgId },
      gracePeriodEndsAt: { S: futureDate(15) },
      canceledAt: { S: pastDate(5) },
    });
  });

  afterAll(async () => {
    await deleteBillingRecord(expiredUserId, expiredOrgId);
    await deleteBillingRecord(activeUserId, activeOrgId);
    await deleteOrgProfile(expiredOrgId);
    await deleteOrgProfile(activeOrgId);
  });

  it('cancels expired record and WRITE_LOCKs active record', async () => {
    const result = await invokeEnforcer();
    expect(result.functionError).toBeUndefined();

    const expiredRecord = await getBillingRecord(expiredUserId, expiredOrgId);
    expect(expiredRecord).not.toBeNull();
    expect(expiredRecord!.subscriptionStatus?.S).toBe(SubscriptionStatus.Canceled);

    const activeRecord = await getBillingRecord(activeUserId, activeOrgId);
    expect(activeRecord).not.toBeNull();
    expect(activeRecord!.subscriptionStatus?.S).toBe(SubscriptionStatus.GracePeriod);
  });
});

// =============================================================================
// 4. The Stripe subscription behind an expired grace period
// =============================================================================
describe('the Stripe subscription behind an expired grace period', () => {
  const tenantId = 'e7da8138-c669-4cc0-82ef-253e534be11c';
  const cleanups: (() => Promise<unknown>)[] = [];

  afterAll(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  /** An org whose expired grace row names `subscriptionId`, seeded once Stripe's own events for it landed. */
  async function seedExpiredGrace(userId: string, customerId: string, subscriptionId: string) {
    await seedOrgProfile(testOrgId(userId), tenantId);
    await seedBillingRecord(userId, customerId, SubscriptionStatus.GracePeriod, {
      subscriptionId: { S: subscriptionId },
      gracePeriodEndsAt: { S: pastDate(1) },
    });
    cleanups.push(
      () => deleteBillingRecord(userId),
      () => deleteOrgProfile(testOrgId(userId)),
    );
  }

  it('cancels a paused trial in Stripe and the row stays canceled after the deletion event', async () => {
    const stripe = getStripeClient();
    const userId = `enforcer-paused-${crypto.randomUUID().slice(0, 8)}`;
    const clockId = await createTestClock('enforcer-paused');
    cleanups.push(() => stripe.testHelpers.testClocks.del(clockId));
    const customerId = await createTestCustomer(userId, clockId);
    const { frozen_time: now } = await stripe.testHelpers.testClocks.retrieve(clockId);
    const { id: subscriptionId } = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: getStripePriceId() }],
      trial_end: now + 3600,
      trial_settings: { end_behavior: { missing_payment_method: 'pause' } },
      metadata: { userId, orgId: testOrgId(userId) },
    });
    await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: now + 2 * 3600 });
    await pollTestClockReady({ clockId });
    expect(await stripe.subscriptions.retrieve(subscriptionId)).toMatchObject({ status: 'paused' });
    await waitForEventHandled('customer.subscription.updated', subscriptionId);
    await seedExpiredGrace(userId, customerId, subscriptionId);

    const result = await invokeEnforcer();

    expect(result.functionError).toBeUndefined();
    expect(await stripe.subscriptions.retrieve(subscriptionId)).toMatchObject({
      status: 'canceled',
    });
    expect((await getBillingRecord(userId))?.subscriptionStatus).toStrictEqual({
      S: SubscriptionStatus.Canceled,
    });
    await waitForEventHandled('customer.subscription.deleted', subscriptionId);
    expect((await getBillingRecord(userId))?.subscriptionStatus).toStrictEqual({
      S: SubscriptionStatus.Canceled,
    });
  }, 420_000);

  it('leaves the row in grace and the subscription active when Stripe still bills it', async () => {
    const userId = `enforcer-live-${crypto.randomUUID().slice(0, 8)}`;
    const customerId = await createTestCustomer(userId);
    cleanups.push(() => getStripeClient().customers.del(customerId));
    const paymentMethodId = await attachValidCard(customerId);
    const subscriptionId = await createSubscription({ userId, customerId, paymentMethodId });
    await waitForEventHandled('customer.subscription.created', subscriptionId);
    await seedExpiredGrace(userId, customerId, subscriptionId);

    const result = await invokeEnforcer();

    expect(result.functionError).toBeUndefined();
    expect(await getStripeClient().subscriptions.retrieve(subscriptionId)).toMatchObject({
      status: 'active',
    });
    expect((await getBillingRecord(userId))?.subscriptionStatus).toStrictEqual({
      S: SubscriptionStatus.GracePeriod,
    });
  });
});
