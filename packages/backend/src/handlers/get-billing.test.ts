import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('get-billing baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns trial state when no billing record exists', async () => {
    ddbMock.on(GetItemCommand).resolves({});

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({
      subscription: {
        planId: PlanId.FreeTrial,
        status: SubscriptionStatus.Trialing,
        trialEndsAt: expect.any(String),
      },
    });
  });

  it('returns trial state when billing record has no stripeCustomerId', async () => {
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
        planId: PlanId.FreeTrial,
        status: SubscriptionStatus.GracePeriod,
        trialEndsAt: expiredTrialEndsAt,
        gracePeriodEndsAt: expect.any(String),
      },
    });

    // Verify UpdateItemCommand was called
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

    mockSubscriptionsRetrieve.mockResolvedValue({
      default_payment_method: {
        id: 'pm_789',
        card: {
          last4: '4242',
          brand: 'visa',
          exp_month: 12,
          exp_year: 2027,
        },
      },
    });

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

  it('transitions expired grace_period to canceled', async () => {
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

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
  });

  it('returns no paymentMethod when none exists', async () => {
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        stripeCustomerId: 'cus_123',
        subscriptionStatus: SubscriptionStatus.Active,
      }),
    );

    mockSubscriptionsRetrieve.mockResolvedValue({
      default_payment_method: null,
    });

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
