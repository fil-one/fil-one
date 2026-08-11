import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { PlanId, SubscriptionStatus } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
    StripeSecretKey: { value: 'sk_test_fake' },
    StripePriceId: { value: 'price_test_fake' },
  },
}));

const mockSubscriptionsRetrieve = vi.fn();

vi.mock('../lib/stripe-client.js', () => ({
  getStripeClient: () => ({
    subscriptions: { retrieve: mockSubscriptionsRetrieve },
  }),
  getBillingSecrets: () => ({
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_PRICE_ID: 'price_test_fake',
  }),
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './get-billing.js';
import { DELETION_GUARD } from '../lib/deletion-guards.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function subscriptionItem(overrides: Record<string, unknown> = {}) {
  return {
    Item: marshall({
      pk: `CUSTOMER#${USER_INFO.userId}`,
      sk: 'SUBSCRIPTION',
      ...overrides,
    }),
  };
}

const METER_ID = 'mtr_61UONtrahRgx1CRqB41AQEKri8lBk7M8';
const PRODUCT_ID = 'prod_UDQoxmv2XKmKsP';

/**
 * Current plan as Stripe returns it: $4.99/TB metered in GB, priced as a
 * graduated tiered price. The first tier's flat fee is the $4.99 monthly
 * minimum and covers the first 1000 GB; above it, usage bills at the same rate,
 * which is sub-cent and therefore exact only in `unit_amount_decimal`.
 */
const TIERED_PRICE = {
  id: 'price_1Tw0qsAQEKri8lBkpE0gCk5G',
  object: 'price',
  active: true,
  billing_scheme: 'tiered',
  created: 1784729426,
  currency: 'usd',
  custom_unit_amount: null,
  livemode: true,
  lookup_key: null,
  metadata: {},
  nickname: '$0.00499 per GB ($4.99 per TB) / mo, with 1TB minimum commitment',
  product: PRODUCT_ID,
  recurring: {
    interval: 'month',
    interval_count: 1,
    meter: METER_ID,
    trial_period_days: null,
    usage_type: 'metered',
  },
  tax_behavior: 'unspecified',
  tiers: [
    {
      up_to: 1000,
      flat_amount: 499,
      flat_amount_decimal: '499',
      unit_amount: 0,
      unit_amount_decimal: '0',
    },
    {
      up_to: null,
      flat_amount: null,
      flat_amount_decimal: null,
      unit_amount: null,
      unit_amount_decimal: '0.499',
    },
  ],
  tiers_mode: 'graduated',
  transform_quantity: null,
  type: 'recurring',
  unit_amount: null,
  unit_amount_decimal: null,
};

/**
 * Grandfathered pre-minimum plan as Stripe returns it: the same $4.99/TB
 * metered in GB, but a plain per-unit price — no tiers, so no minimum. The
 * sub-cent rate leaves `unit_amount` null and lives in `unit_amount_decimal`.
 */
const GRANDFATHERED_PRICE = {
  id: 'price_1TEzwVAQEKri8lBkcbnifwsE',
  object: 'price',
  active: true,
  billing_scheme: 'per_unit',
  created: 1774477827,
  currency: 'usd',
  custom_unit_amount: null,
  livemode: true,
  lookup_key: null,
  metadata: {},
  nickname: '$0.00499 per GB ($4.99 per TB) / mo',
  product: PRODUCT_ID,
  recurring: {
    interval: 'month',
    interval_count: 1,
    meter: METER_ID,
    trial_period_days: null,
    usage_type: 'metered',
  },
  tax_behavior: 'unspecified',
  tiers_mode: null,
  transform_quantity: null,
  type: 'recurring',
  unit_amount: null,
  unit_amount_decimal: '0.499',
};

/** The trimmed snapshots persisted on the billing record — immutable fields only. */
const CACHED_TIERED_PRICE = {
  id: TIERED_PRICE.id,
  product: PRODUCT_ID,
  currency: 'usd',
  billing_scheme: 'tiered',
  tiers_mode: 'graduated',
  unit_amount: null,
  unit_amount_decimal: null,
  tiers: TIERED_PRICE.tiers,
  recurring: { interval: 'month', interval_count: 1, usage_type: 'metered', meter: METER_ID },
};

const CACHED_GRANDFATHERED_PRICE = {
  id: GRANDFATHERED_PRICE.id,
  product: PRODUCT_ID,
  currency: 'usd',
  billing_scheme: 'per_unit',
  tiers_mode: null,
  unit_amount: null,
  unit_amount_decimal: '0.499',
  recurring: { interval: 'month', interval_count: 1, usage_type: 'metered', meter: METER_ID },
};

function stripeSubscription(price?: Record<string, unknown>, overrides: object = {}) {
  return {
    default_payment_method: null,
    ...(price ? { items: { data: [{ price }] } } : {}),
    ...overrides,
  };
}

/** Stripe's 404 for a subscription deleted upstream, as the SDK surfaces it. */
function stripeResourceMissing() {
  const err = new Error("No such subscription: 'sub_456'") as Error & { code: string };
  err.code = 'resource_missing';
  return err;
}

function activeRecordWith(overrides: Record<string, unknown> = {}) {
  return subscriptionItem({
    stripeCustomerId: 'cus_123',
    subscriptionId: 'sub_456',
    subscriptionStatus: SubscriptionStatus.Active,
    ...overrides,
  });
}

function storedStripePrice() {
  const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
  const values = updateCalls.at(0)?.args.at(0)?.input.ExpressionAttributeValues;
  return values?.[':price'] ? unmarshall(values[':price'].M as never) : undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-billing baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  // The distinction the endpoint rests on: absent status ⇒ inactive; present
  // status with no Stripe customer ⇒ report that stored status.

  it('reports an inactive subscription when no billing record exists', async () => {
    ddbMock.on(GetItemCommand).resolves({});

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({
      subscription: {
        planId: PlanId.None,
        status: SubscriptionStatus.Inactive,
      },
    });
  });

  // A record can exist without a subscriptionStatus (e.g. the customer mapping
  // create-setup-intent writes). No status means no entitlement — the guard
  // 403s these accounts, and this endpoint must not report a trial for them.
  const statuslessRecordVariants: Record<string, Record<string, unknown>> = {
    'bare record': {},
    'customer mapping only': { stripeCustomerId: 'cus_123', orgId: 'org-1' },
    'customer mapping with cached price': {
      stripeCustomerId: 'cus_123',
      stripePrice: CACHED_GRANDFATHERED_PRICE,
    },
  };
  for (const [description, overrides] of Object.entries(statuslessRecordVariants)) {
    it(`reports inactive for a record with no subscription status (${description})`, async () => {
      ddbMock.on(GetItemCommand).resolves(subscriptionItem(overrides));

      const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(String(result.body));
      expect(body).toStrictEqual({
        subscription: {
          planId: PlanId.None,
          status: SubscriptionStatus.Inactive,
        },
      });
    });
  }

  it('reports the cached card for an inactive record that has one', async () => {
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        stripeCustomerId: 'cus_123',
        paymentMethodId: 'pm_cached',
        paymentMethodLast4: '1234',
        paymentMethodBrand: 'mastercard',
        paymentMethodExpMonth: 6,
        paymentMethodExpYear: 2028,
      }),
    );

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({
      subscription: {
        planId: PlanId.None,
        status: SubscriptionStatus.Inactive,
      },
      paymentMethod: {
        id: 'pm_cached',
        last4: '1234',
        brand: 'mastercard',
        expMonth: 6,
        expYear: 2028,
      },
    });
  });

  it('does not call Stripe when the record has no subscription status', async () => {
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        stripeCustomerId: 'cus_123',
        subscriptionId: 'sub_456',
      }),
    );

    await baseHandler(buildEvent({ userInfo: USER_INFO }));

    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
  });

  it('never writes to DynamoDB when reporting inactive', async () => {
    ddbMock.on(GetItemCommand).resolves(subscriptionItem({ stripeCustomerId: 'cus_123' }));

    await baseHandler(buildEvent({ userInfo: USER_INFO }));

    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  // Records with a status but no stripeCustomerId exist in production (webhook
  // upserts that never read the local record). They must report their STORED
  // status — not a hardcoded trial. planId follows the buildBillingResponse
  // mapping.
  //
  // Two writer shapes produce them, and a `subscriptionId` is what tells them
  // apart — so the cases below deliberately cover both:
  //   - WITH subscriptionId — `handleSubscriptionUpdate` → `updateBillingRecord`
  //     resolves the userId from Stripe metadata and writes subscriptionId +
  //     status without ever reading the local record.
  //   - WITHOUT subscriptionId — `handlePaymentFailed` (→ past_due) and
  //     `handlePaymentSucceeded` (→ active) write ONLY a status plus a payment
  //     timestamp. So a past_due record with no linked subscription is a real
  //     production shape, not an incomplete fixture: the invoice webhook never
  //     had a subscription id in hand to write.
  const trialEndsAtStored = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const graceEndsAtStored = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const orphanRecordCases: Record<
    string,
    { record: Record<string, unknown>; expected: Record<string, unknown> }
  > = {
    active: {
      record: { subscriptionStatus: SubscriptionStatus.Active, subscriptionId: 'sub_456' },
      expected: { planId: PlanId.PayAsYouGo, status: SubscriptionStatus.Active },
    },
    // handlePaymentFailed's exact write shape: status + failure timestamp only.
    past_due: {
      record: {
        subscriptionStatus: SubscriptionStatus.PastDue,
        lastPaymentFailedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      },
      expected: { planId: PlanId.PayAsYouGo, status: SubscriptionStatus.PastDue },
    },
    grace_period: {
      record: {
        subscriptionStatus: SubscriptionStatus.GracePeriod,
        gracePeriodEndsAt: graceEndsAtStored,
      },
      expected: {
        planId: PlanId.PayAsYouGo,
        status: SubscriptionStatus.GracePeriod,
        gracePeriodEndsAt: graceEndsAtStored,
      },
    },
    trialing: {
      record: {
        subscriptionStatus: SubscriptionStatus.Trialing,
        subscriptionId: 'sub_456',
        trialEndsAt: trialEndsAtStored,
      },
      expected: {
        planId: PlanId.FreeTrial,
        status: SubscriptionStatus.Trialing,
        trialEndsAt: trialEndsAtStored,
      },
    },
  };
  for (const [status, { record, expected }] of Object.entries(orphanRecordCases)) {
    it(`reports the stored ${status} status for a record with no Stripe customer`, async () => {
      ddbMock.on(GetItemCommand).resolves(subscriptionItem(record));

      const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(String(result.body));
      expect(body).toStrictEqual({ subscription: expected });
    });
  }

  it('reports the cached minimum for a record with no Stripe customer', async () => {
    // No Stripe customer means no live price to read, but the cached snapshot
    // is still authoritative for what the customer is billed — reporting no
    // minimum here would understate it.
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        subscriptionStatus: SubscriptionStatus.Active,
        stripePrice: CACHED_TIERED_PRICE,
      }),
    );

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const body = JSON.parse(String(result.body));
    expect(body.subscription).toStrictEqual({
      planId: PlanId.PayAsYouGo,
      status: SubscriptionStatus.Active,
      monthlyMinimumCents: 499,
    });
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
  });

  it('reports no minimum for a record with neither a Stripe customer nor a cached price', async () => {
    // Factual, not a fabrication: with no Stripe customer there is no
    // subscription for a minimum to be billed on.
    ddbMock
      .on(GetItemCommand)
      .resolves(subscriptionItem({ subscriptionStatus: SubscriptionStatus.Active }));

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const body = JSON.parse(String(result.body));
    expect(body.subscription.monthlyMinimumCents).toBeUndefined();
  });

  it('does not call Stripe for a record with a status but no Stripe customer', async () => {
    // Even with a subscriptionId on the record there is no customer id to look
    // up, so this branch must stay Stripe-free.
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        subscriptionStatus: SubscriptionStatus.Active,
        subscriptionId: 'sub_456',
      }),
    );

    await baseHandler(buildEvent({ userInfo: USER_INFO }));

    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
  });

  it('reports the recorded trial when the record has no Stripe customer', async () => {
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        subscriptionStatus: SubscriptionStatus.Trialing,
        trialEndsAt,
      }),
    );

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({
      subscription: {
        planId: PlanId.FreeTrial,
        status: SubscriptionStatus.Trialing,
        trialEndsAt,
      },
    });
  });

  it('transitions expired trial to grace_period (no stripe customer)', async () => {
    const expiredTrialEndsAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        subscriptionStatus: SubscriptionStatus.Trialing,
        trialEndsAt: expiredTrialEndsAt,
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({
      subscription: {
        planId: PlanId.PayAsYouGo,
        status: SubscriptionStatus.GracePeriod,
        trialEndsAt: expiredTrialEndsAt,
        gracePeriodEndsAt: expect.any(String),
      },
    });

    // The lazy trial→grace transition must still persist, now from the single
    // surviving implementation in evaluateStatusTransitions.
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
  });

  it('returns active subscription with payment method from Stripe', async () => {
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        stripeCustomerId: 'cus_123',
        subscriptionId: 'sub_456',
        subscriptionStatus: SubscriptionStatus.Active,
        currentPeriodEnd: '2026-04-01T00:00:00Z',
      }),
    );

    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(
      stripeSubscription(GRANDFATHERED_PRICE, {
        default_payment_method: {
          id: 'pm_789',
          card: {
            last4: '4242',
            brand: 'visa',
            exp_month: 12,
            exp_year: 2027,
          },
        },
      }),
    );

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({
      subscription: {
        planId: PlanId.PayAsYouGo,
        status: SubscriptionStatus.Active,
        currentPeriodEnd: '2026-04-01T00:00:00Z',
      },
      paymentMethod: {
        id: 'pm_789',
        last4: '4242',
        brand: 'visa',
        expMonth: 12,
        expYear: 2027,
      },
    });
  });

  it('falls back to cached payment method when Stripe fetch fails', async () => {
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        stripeCustomerId: 'cus_123',
        subscriptionId: 'sub_456',
        subscriptionStatus: SubscriptionStatus.Active,
        stripePrice: CACHED_GRANDFATHERED_PRICE,
        paymentMethodId: 'pm_cached',
        paymentMethodLast4: '1234',
        paymentMethodBrand: 'mastercard',
        paymentMethodExpMonth: 6,
        paymentMethodExpYear: 2028,
      }),
    );

    mockSubscriptionsRetrieve.mockRejectedValue(new Error('Stripe unavailable'));

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({
      subscription: {
        planId: PlanId.PayAsYouGo,
        status: SubscriptionStatus.Active,
      },
      paymentMethod: {
        id: 'pm_cached',
        last4: '1234',
        brand: 'mastercard',
        expMonth: 6,
        expYear: 2028,
      },
    });
  });

  it('transitions expired trial to grace_period (with stripe customer)', async () => {
    const expiredTrialEndsAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        stripeCustomerId: 'cus_123',
        subscriptionStatus: SubscriptionStatus.Trialing,
        trialEndsAt: expiredTrialEndsAt,
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({
      subscription: {
        planId: PlanId.PayAsYouGo,
        status: SubscriptionStatus.GracePeriod,
        trialEndsAt: expiredTrialEndsAt,
        gracePeriodEndsAt: expect.any(String),
      },
    });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // FIL-112 — both writers on this read path are upsert-capable, so an
  // unconditioned write would recreate a billing record the account teardown
  // already purged. A guard rejection is a skip: the read model still answers.
  // -------------------------------------------------------------------------

  it('fences the cached-price refresh with the deletion guard', async () => {
    ddbMock.on(GetItemCommand).resolves(activeRecordWith());
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription(TIERED_PRICE));

    await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const priceWrites = ddbMock
      .commandCalls(UpdateItemCommand)
      .filter((call) => String(call.args[0].input.UpdateExpression).includes('stripePrice'));
    expect(priceWrites).toHaveLength(1);
    expect(priceWrites[0].args[0].input).toMatchObject({ ConditionExpression: DELETION_GUARD });
  });

  it('still serves billing details when the deletion guard rejects the price-cache write', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ddbMock.on(GetItemCommand).resolves(activeRecordWith());
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      }),
    );
    mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription(TIERED_PRICE));

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    expect(result.statusCode).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('org mid-deletion'),
      expect.objectContaining({ source: 'get-billing.cacheStripePrice' }),
    );
  });

  it('fences the lazy trial → grace_period transition with the deletion guard', async () => {
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        subscriptionStatus: SubscriptionStatus.Trialing,
        trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});

    await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input).toMatchObject({ ConditionExpression: DELETION_GUARD });
  });

  it('still reports grace_period when the deletion guard rejects the transition write', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const expiredTrialEndsAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        subscriptionStatus: SubscriptionStatus.Trialing,
        trialEndsAt: expiredTrialEndsAt,
      }),
    );
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      }),
    );

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body.subscription.status).toBe(SubscriptionStatus.GracePeriod);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('org mid-deletion'),
      expect.objectContaining({ source: 'get-billing.evaluateStatusTransitions' }),
    );
  });

  it('reports expired grace_period as canceled but does NOT persist the transition', async () => {
    const expiredGracePeriod = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        stripeCustomerId: 'cus_123',
        subscriptionStatus: SubscriptionStatus.GracePeriod,
        gracePeriodEndsAt: expiredGracePeriod,
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({
      subscription: {
        planId: PlanId.PayAsYouGo,
        status: SubscriptionStatus.Canceled,
        gracePeriodEndsAt: expiredGracePeriod,
      },
    });

    // Surfaces `canceled` in the response, but must NOT write it: the record
    // stays `grace_period` so the grace-period-enforcer still disables the
    // tenant. Persisting `canceled` here would hide it from the enforcer.
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('returns no paymentMethod when none exists', async () => {
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        stripeCustomerId: 'cus_123',
        subscriptionStatus: SubscriptionStatus.Active,
      }),
    );

    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription(GRANDFATHERED_PRICE));

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({
      subscription: {
        planId: PlanId.PayAsYouGo,
        status: SubscriptionStatus.Active,
      },
    });
  });

  it('reports the monthly minimum from the tiered price first tier', async () => {
    ddbMock.on(GetItemCommand).resolves(activeRecordWith());
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription(TIERED_PRICE));

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const body = JSON.parse(String(result.body));
    expect(body.subscription).toStrictEqual({
      planId: PlanId.PayAsYouGo,
      status: SubscriptionStatus.Active,
      monthlyMinimumCents: 499,
    });
  });

  it('reports the monthly minimum when the flat fee is only set as a decimal', async () => {
    ddbMock.on(GetItemCommand).resolves(activeRecordWith());
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(
      stripeSubscription({
        ...TIERED_PRICE,
        tiers: [
          {
            up_to: 1000,
            flat_amount: null,
            flat_amount_decimal: '499',
            unit_amount: 0,
            unit_amount_decimal: '0',
          },
          ...TIERED_PRICE.tiers.slice(1),
        ],
      }),
    );

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const body = JSON.parse(String(result.body));
    expect(body.subscription.monthlyMinimumCents).toBe(499);
  });

  it('omits the monthly minimum when the first tier charges per unit with no flat fee', async () => {
    ddbMock.on(GetItemCommand).resolves(activeRecordWith());
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(
      stripeSubscription({
        ...TIERED_PRICE,
        tiers: [
          {
            up_to: 1000,
            flat_amount: null,
            flat_amount_decimal: null,
            unit_amount: 0,
            unit_amount_decimal: '0.499',
          },
          ...TIERED_PRICE.tiers.slice(1),
        ],
      }),
    );

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const body = JSON.parse(String(result.body));
    expect(body.subscription.monthlyMinimumCents).toBeUndefined();
  });

  it('omits the monthly minimum for a volume-tiered price', async () => {
    ddbMock.on(GetItemCommand).resolves(activeRecordWith());
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(
      stripeSubscription({ ...TIERED_PRICE, tiers_mode: 'volume' }),
    );

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const body = JSON.parse(String(result.body));
    expect(body.subscription).toStrictEqual({
      planId: PlanId.PayAsYouGo,
      status: SubscriptionStatus.Active,
    });
  });

  const missingTiersCases: Record<string, unknown> = {
    'the tiers are missing': undefined,
    'the tiers are empty': [],
  };
  for (const [description, tiers] of Object.entries(missingTiersCases)) {
    it(`fails when a graduated price has no first tier because ${description}`, async () => {
      ddbMock.on(GetItemCommand).resolves(activeRecordWith());
      ddbMock.on(UpdateItemCommand).resolves({});
      mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription({ ...TIERED_PRICE, tiers }));

      await expect(baseHandler(buildEvent({ userInfo: USER_INFO }))).rejects.toThrow(
        `Graduated price ${TIERED_PRICE.id} has no tiers`,
      );
    });
  }

  it('fails when the first tier flat amount decimal is not a number', async () => {
    ddbMock.on(GetItemCommand).resolves(activeRecordWith());
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(
      stripeSubscription({
        ...TIERED_PRICE,
        tiers: [{ ...TIERED_PRICE.tiers[0], flat_amount_decimal: 'not-a-number' }],
      }),
    );

    await expect(baseHandler(buildEvent({ userInfo: USER_INFO }))).rejects.toThrow(
      'Stripe amount decimal is not a number: "not-a-number"',
    );
  });

  it('omits the monthly minimum for a grandfathered per-unit price', async () => {
    ddbMock.on(GetItemCommand).resolves(activeRecordWith());
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription(GRANDFATHERED_PRICE));

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const body = JSON.parse(String(result.body));
    expect(body.subscription).toStrictEqual({
      planId: PlanId.PayAsYouGo,
      status: SubscriptionStatus.Active,
    });
  });

  it('reports the monthly minimum while trialing on the tiered price', async () => {
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    ddbMock
      .on(GetItemCommand)
      .resolves(activeRecordWith({ subscriptionStatus: SubscriptionStatus.Trialing, trialEndsAt }));
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription(TIERED_PRICE));

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const body = JSON.parse(String(result.body));
    expect(body.subscription).toStrictEqual({
      planId: PlanId.FreeTrial,
      status: SubscriptionStatus.Trialing,
      trialEndsAt,
      monthlyMinimumCents: 499,
    });
  });

  it('caches only the immutable price fields, dropping the mutable cosmetic ones', async () => {
    ddbMock.on(GetItemCommand).resolves(activeRecordWith());
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription(TIERED_PRICE));

    await baseHandler(buildEvent({ userInfo: USER_INFO }));

    expect(storedStripePrice()).toStrictEqual(CACHED_TIERED_PRICE);
  });

  it('does not rewrite the cached price when the price is unchanged', async () => {
    ddbMock.on(GetItemCommand).resolves(activeRecordWith({ stripePrice: CACHED_TIERED_PRICE }));
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription(TIERED_PRICE));

    await baseHandler(buildEvent({ userInfo: USER_INFO }));

    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('rewrites the cached price when the org moved to a different price', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolves(activeRecordWith({ stripePrice: CACHED_GRANDFATHERED_PRICE }));
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription(TIERED_PRICE));

    await baseHandler(buildEvent({ userInfo: USER_INFO }));

    expect(storedStripePrice()).toStrictEqual(CACHED_TIERED_PRICE);
  });

  it('serves the minimum from the cached price when Stripe fetch fails', async () => {
    ddbMock.on(GetItemCommand).resolves(activeRecordWith({ stripePrice: CACHED_TIERED_PRICE }));
    mockSubscriptionsRetrieve.mockRejectedValue(new Error('Stripe unavailable'));

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const body = JSON.parse(String(result.body));
    expect(body.subscription).toStrictEqual({
      planId: PlanId.PayAsYouGo,
      status: SubscriptionStatus.Active,
      monthlyMinimumCents: 499,
    });
  });

  it('fails with 502 when Stripe fetch fails and no price is cached', async () => {
    ddbMock.on(GetItemCommand).resolves(activeRecordWith());
    mockSubscriptionsRetrieve.mockRejectedValue(new Error('Stripe unavailable'));

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    expect(result.statusCode).toBe(502);
  });

  it('reports no minimum when the subscription is gone from Stripe', async () => {
    ddbMock.on(GetItemCommand).resolves(activeRecordWith());
    mockSubscriptionsRetrieve.mockRejectedValue(stripeResourceMissing());

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const body = JSON.parse(String(result.body));
    expect(body.subscription).toStrictEqual({
      planId: PlanId.PayAsYouGo,
      status: SubscriptionStatus.Active,
    });
  });

  it('serves the cached minimum when the subscription is gone from Stripe', async () => {
    ddbMock.on(GetItemCommand).resolves(activeRecordWith({ stripePrice: CACHED_TIERED_PRICE }));
    mockSubscriptionsRetrieve.mockRejectedValue(stripeResourceMissing());

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const body = JSON.parse(String(result.body));
    expect(body.subscription).toStrictEqual({
      planId: PlanId.PayAsYouGo,
      status: SubscriptionStatus.Active,
      monthlyMinimumCents: 499,
    });
  });

  it('expands the price tiers when retrieving the Stripe subscription', async () => {
    ddbMock.on(GetItemCommand).resolves(activeRecordWith({ stripePrice: CACHED_TIERED_PRICE }));
    mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription(TIERED_PRICE));

    await baseHandler(buildEvent({ userInfo: USER_INFO }));

    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_456', {
      expand: ['default_payment_method', 'items.data.price.tiers'],
    });
  });

  it('queries DynamoDB with correct key', async () => {
    ddbMock.on(GetItemCommand).resolves({});

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    const calls = ddbMock.commandCalls(GetItemCommand);
    expect(calls).toHaveLength(1);
    const input = calls.at(0)?.args.at(0)?.input;
    expect(input).toStrictEqual({
      TableName: 'BillingTable',
      Key: {
        pk: { S: 'CUSTOMER#user-1' },
        sk: { S: 'SUBSCRIPTION' },
      },
    });
  });
});
