import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { SubscriptionStatus } from '@filone/shared';
import { FINAL_SETUP_STATUS } from '../lib/org-setup-status.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSetupIntentsList = vi.fn();
const mockSubscriptionsCreate = vi.fn();
const mockSubscriptionsUpdate = vi.fn();
const mockPromotionCodesList = vi.fn();

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
    UserInfoTable: { name: 'UserInfoTable' },
    StripeSecretKey: { value: 'sk_test_fake' },
    StripePriceId: { value: 'price_test_fake' },
  },
}));

const mockUpdateTenantStatus = vi.fn();
vi.mock('../lib/aurora-backoffice.js', () => ({
  updateTenantStatus: (...args: unknown[]) => mockUpdateTenantStatus(...args),
}));

vi.mock('../lib/stripe-client.js', () => ({
  getStripeClient: () => ({
    setupIntents: { list: mockSetupIntentsList },
    subscriptions: { create: mockSubscriptionsCreate, update: mockSubscriptionsUpdate },
    promotionCodes: { list: mockPromotionCodesList },
  }),
  getBillingSecrets: () => ({
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_PRICE_ID: 'price_test_fake',
  }),
}));

// Must mock auth/csrf middleware to pass through
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: () => ({
    before: async (request: { event: { requestContext: { userInfo: unknown } } }) => {
      request.event.requestContext.userInfo = {
        userId: 'user-1',
        email: 'test@example.com',
        orgId: 'org-1',
      };
    },
  }),
}));

vi.mock('../middleware/csrf.js', () => ({
  csrfMiddleware: () => ({ before: async () => {} }),
}));

const ddbMock = mockClient(DynamoDBClient);

import { handler } from './activate-subscription.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildBillingRecord(overrides?: Record<string, unknown>) {
  const base: Record<string, unknown> = {
    pk: 'CUSTOMER#user-1',
    sk: 'SUBSCRIPTION',
    stripeCustomerId: 'cus_test_123',
    orgId: 'org-1',
    subscriptionStatus: SubscriptionStatus.Trialing,
    ...overrides,
  };
  for (const key of Object.keys(base)) {
    if (base[key] === undefined) delete base[key];
  }
  return marshall(base);
}

function orgProfileWithTenant(tenantId: string) {
  return {
    Item: {
      pk: { S: 'ORG#org-1' },
      sk: { S: 'PROFILE' },
      auroraTenantId: { S: tenantId },
      setupStatus: { S: FINAL_SETUP_STATUS },
    },
  };
}

function mockSubscriptionResponse(overrides?: Record<string, unknown>) {
  return {
    id: 'sub_test_456',
    status: 'trialing',
    default_payment_method: {
      id: 'pm_test_789',
      card: { last4: '4242', brand: 'visa', exp_month: 12, exp_year: 2027 },
    },
    items: { data: [{ current_period_end: 1701209600 }] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('activate-subscription handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    mockSetupIntentsList.mockReset();
    mockSubscriptionsCreate.mockReset();
    mockSubscriptionsUpdate.mockReset();
    mockPromotionCodesList.mockReset();
    mockUpdateTenantStatus.mockReset();

    mockSetupIntentsList.mockResolvedValue({
      data: [{ status: 'succeeded', payment_method: 'pm_test_789' }],
    });
    mockUpdateTenantStatus.mockResolvedValue({});
  });

  it('updates existing trial subscription when subscriptionId exists', async () => {
    // Record has subscriptionId from billing-trial-setup
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({
        Item: buildBillingRecord({
          subscriptionId: 'sub_trial_123',
          subscriptionStatus: SubscriptionStatus.Trialing,
        }),
      })
      .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await handler(event, {} as never);
    const body = JSON.parse((result as { body: string }).body);

    // Should call update twice (attach PM, then end trial), NOT create
    expect(mockSubscriptionsUpdate).toHaveBeenCalledTimes(2);
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();

    expect(body.subscription.status).toBe(SubscriptionStatus.Active);
  });

  it('attaches payment method before ending trial to prevent cancellation', async () => {
    // This test covers a bug where sending trial_end and default_payment_method
    // in a single call caused Stripe's missing_payment_method:'cancel' behavior
    // to fire before the payment method was fully attached, canceling the subscription.
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({
        Item: buildBillingRecord({
          subscriptionId: 'sub_trial_123',
          subscriptionStatus: SubscriptionStatus.Trialing,
        }),
      })
      .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    await handler(event, {} as never);

    // Step 1: Attach payment method only
    expect(mockSubscriptionsUpdate).toHaveBeenNthCalledWith(1, 'sub_trial_123', {
      default_payment_method: 'pm_test_789',
    });

    // Step 2: End trial separately — payment method is already attached
    expect(mockSubscriptionsUpdate).toHaveBeenNthCalledWith(2, 'sub_trial_123', {
      trial_end: 'now',
      expand: ['latest_invoice.payment_intent', 'default_payment_method'],
    });
  });

  it('creates new subscription when no subscriptionId exists (legacy path)', async () => {
    // Record without subscriptionId (legacy)
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({ Item: buildBillingRecord() })
      .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await handler(event, {} as never);
    const body = JSON.parse((result as { body: string }).body);

    // Should call create, NOT update
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
      customer: 'cus_test_123',
      items: [{ price: 'price_test_fake' }],
      default_payment_method: 'pm_test_789',
      expand: ['latest_invoice.payment_intent', 'default_payment_method'],
    });
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();

    expect(body.subscription.status).toBe(SubscriptionStatus.Active);
  });

  it('creates a new subscription when reactivating a canceled subscription (GracePeriod)', async () => {
    // Record retains the stale subscriptionId from the canceled Stripe subscription;
    // the webhook clears it later via customer.subscription.created.
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({
        Item: buildBillingRecord({
          subscriptionId: 'sub_canceled_old',
          subscriptionStatus: SubscriptionStatus.GracePeriod,
        }),
      })
      .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await handler(event, {} as never);
    const body = JSON.parse((result as { body: string }).body);

    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
      customer: 'cus_test_123',
      items: [{ price: 'price_test_fake' }],
      default_payment_method: 'pm_test_789',
      expand: ['latest_invoice.payment_intent', 'default_payment_method'],
    });
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();

    expect(body.subscription.status).toBe(SubscriptionStatus.Active);
  });

  it('creates a new subscription when reactivating a fully canceled subscription (Canceled)', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({
        Item: buildBillingRecord({
          subscriptionId: 'sub_canceled_old',
          subscriptionStatus: SubscriptionStatus.Canceled,
        }),
      })
      .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await handler(event, {} as never);
    const body = JSON.parse((result as { body: string }).body);

    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
      customer: 'cus_test_123',
      items: [{ price: 'price_test_fake' }],
      default_payment_method: 'pm_test_789',
      expand: ['latest_invoice.payment_intent', 'default_payment_method'],
    });
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();

    expect(body.subscription.status).toBe(SubscriptionStatus.Active);
  });

  it('removes trialEndsAt when updating trial subscription (trial_end: now)', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({ Item: buildBillingRecord({ subscriptionId: 'sub_trial_123' }) })
      .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    await handler(event, {} as never);

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(2); // billing update + org profile auroraTenantStatus
    const updateExpr = updateCalls[0].args[0].input.UpdateExpression as string;
    // trial_end: 'now' makes Stripe return active, so trialEndsAt should be removed
    expect(updateExpr).toContain('REMOVE trialEndsAt');
  });

  it('removes trialEndsAt when subscription is active', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({ Item: buildBillingRecord() })
      .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    await handler(event, {} as never);

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(2); // billing update + org profile auroraTenantStatus
    const updateExpr = updateCalls[0].args[0].input.UpdateExpression as string;
    expect(updateExpr).toContain('REMOVE trialEndsAt');
  });

  it('returns 402 when subscription status is incomplete after activation (3DS pending)', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({ Item: buildBillingRecord({ subscriptionId: 'sub_trial_123' }) });
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'incomplete' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await handler(event, {} as never);
    const body = JSON.parse((result as { body: string }).body);

    expect((result as { statusCode: number }).statusCode).toBe(402);
    expect(body.message).toContain('Additional authentication');

    // DynamoDB should NOT have been updated with the subscription status
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);

    // Aurora tenant should NOT have been unlocked
    expect(mockUpdateTenantStatus).not.toHaveBeenCalled();
  });

  it('returns 402 when subscription status is unpaid after activation', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({ Item: buildBillingRecord({ subscriptionId: 'sub_trial_123' }) });
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'unpaid' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await handler(event, {} as never);

    expect((result as { statusCode: number }).statusCode).toBe(402);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(mockUpdateTenantStatus).not.toHaveBeenCalled();
  });

  it('returns 500 when Aurora org setup is incomplete', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({ Item: buildBillingRecord({ subscriptionId: 'sub_trial_123' }) })
      .resolvesOnce({
        Item: {
          pk: { S: 'ORG#org-1' },
          sk: { S: 'PROFILE' },
          auroraTenantId: { S: 'aurora-t-1' },
          setupStatus: { S: 'AURORA_TENANT_CREATED' },
        },
      });
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await handler(event, {} as never);
    expect((result as { statusCode: number }).statusCode).toBe(500);
  });

  it('returns 500 when auroraTenantId is missing from profile', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({ Item: buildBillingRecord({ subscriptionId: 'sub_trial_123' }) })
      .resolvesOnce({
        Item: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } },
      });
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await handler(event, {} as never);
    expect((result as { statusCode: number }).statusCode).toBe(500);
  });

  it('returns 500 when profile DynamoDB lookup fails', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({ Item: buildBillingRecord({ subscriptionId: 'sub_trial_123' }) })
      .rejectsOnce(new Error('DynamoDB error'));
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await handler(event, {} as never);
    expect((result as { statusCode: number }).statusCode).toBe(500);
  });

  it('returns 500 when updateTenantStatus fails', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({ Item: buildBillingRecord({ subscriptionId: 'sub_trial_123' }) })
      .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));
    mockUpdateTenantStatus.mockRejectedValue(new Error('Aurora down'));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await handler(event, {} as never);
    expect((result as { statusCode: number }).statusCode).toBe(500);
  });

  // ── useSavedPaymentMethod path ────────────────────────────────────

  it('reactivates a canceled subscription using the saved payment method (GracePeriod)', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({
        Item: buildBillingRecord({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          subscriptionId: 'sub_canceled_old',
          paymentMethodId: 'pm_saved_1',
        }),
      })
      .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsCreate.mockResolvedValue(
      mockSubscriptionResponse({ id: 'sub_new_999', status: 'active' }),
    );

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
      body: JSON.stringify({ useSavedPaymentMethod: true }),
    });
    const result = await handler(event, {} as never);
    const body = JSON.parse((result as { body: string }).body);

    expect(mockSetupIntentsList).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
      customer: 'cus_test_123',
      items: [{ price: 'price_test_fake' }],
      default_payment_method: 'pm_saved_1',
      expand: ['latest_invoice.payment_intent', 'default_payment_method'],
    });
    expect(body.subscription.status).toBe(SubscriptionStatus.Active);
  });

  it('reactivates a canceled subscription using the saved payment method (Canceled)', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolvesOnce({
        Item: buildBillingRecord({
          subscriptionStatus: SubscriptionStatus.Canceled,
          subscriptionId: 'sub_canceled_old',
          paymentMethodId: 'pm_saved_1',
        }),
      })
      .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
      body: JSON.stringify({ useSavedPaymentMethod: true }),
    });
    const result = await handler(event, {} as never);
    const body = JSON.parse((result as { body: string }).body);

    expect(mockSetupIntentsList).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(body.subscription.status).toBe(SubscriptionStatus.Active);
  });

  it('rejects useSavedPaymentMethod when subscription is active', async () => {
    ddbMock.on(GetItemCommand).resolvesOnce({
      Item: buildBillingRecord({
        subscriptionStatus: SubscriptionStatus.Active,
        paymentMethodId: 'pm_saved_1',
      }),
    });

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
      body: JSON.stringify({ useSavedPaymentMethod: true }),
    });
    const result = await handler(event, {} as never);

    expect((result as { statusCode: number }).statusCode).toBe(400);
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
  });

  it('rejects useSavedPaymentMethod when subscription is trialing', async () => {
    ddbMock.on(GetItemCommand).resolvesOnce({
      Item: buildBillingRecord({
        subscriptionStatus: SubscriptionStatus.Trialing,
        paymentMethodId: 'pm_saved_1',
      }),
    });

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
      body: JSON.stringify({ useSavedPaymentMethod: true }),
    });
    const result = await handler(event, {} as never);

    expect((result as { statusCode: number }).statusCode).toBe(400);
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('rejects useSavedPaymentMethod when no saved payment method exists', async () => {
    ddbMock.on(GetItemCommand).resolvesOnce({
      Item: buildBillingRecord({
        subscriptionStatus: SubscriptionStatus.Canceled,
        // paymentMethodId intentionally omitted
      }),
    });

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
      body: JSON.stringify({ useSavedPaymentMethod: true }),
    });
    const result = await handler(event, {} as never);
    const body = JSON.parse((result as { body: string }).body);

    expect((result as { statusCode: number }).statusCode).toBe(400);
    expect(body.message).toContain('No saved payment method');
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('returns 402 for useSavedPaymentMethod when subscription is incomplete', async () => {
    ddbMock.on(GetItemCommand).resolvesOnce({
      Item: buildBillingRecord({
        subscriptionStatus: SubscriptionStatus.Canceled,
        paymentMethodId: 'pm_saved_1',
      }),
    });

    mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'incomplete' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
      body: JSON.stringify({ useSavedPaymentMethod: true }),
    });
    const result = await handler(event, {} as never);

    expect((result as { statusCode: number }).statusCode).toBe(402);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(mockUpdateTenantStatus).not.toHaveBeenCalled();
  });

  // ── promotion code ────────────────────────────────────────────────────

  describe('promotion code', () => {
    it('applies the discount in its own update between PM-attach and trial-end (trial→paid)', async () => {
      ddbMock
        .on(GetItemCommand)
        .resolvesOnce({
          Item: buildBillingRecord({
            subscriptionId: 'sub_trial_123',
            subscriptionStatus: SubscriptionStatus.Trialing,
          }),
        })
        .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
      ddbMock.on(UpdateItemCommand).resolves({});

      mockPromotionCodesList.mockResolvedValue({ data: [{ id: 'promo_xxx' }] });
      mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

      const event = buildEvent({
        userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
        method: 'POST',
        rawPath: '/api/billing/activate',
        body: JSON.stringify({ promotionCode: 'WELCOME20' }),
      });
      await handler(event, {} as never);

      expect(mockPromotionCodesList).toHaveBeenCalledWith({
        code: 'WELCOME20',
        active: true,
        limit: 1,
      });
      expect(mockSubscriptionsUpdate).toHaveBeenCalledTimes(3);
      expect(mockSubscriptionsUpdate).toHaveBeenNthCalledWith(1, 'sub_trial_123', {
        default_payment_method: 'pm_test_789',
      });
      expect(mockSubscriptionsUpdate).toHaveBeenNthCalledWith(2, 'sub_trial_123', {
        discounts: [{ promotion_code: 'promo_xxx' }],
      });
      expect(mockSubscriptionsUpdate).toHaveBeenNthCalledWith(3, 'sub_trial_123', {
        trial_end: 'now',
        expand: ['latest_invoice.payment_intent', 'default_payment_method'],
      });
      expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    });

    it('includes discounts in subscriptions.create on the fresh-create path', async () => {
      ddbMock
        .on(GetItemCommand)
        .resolvesOnce({ Item: buildBillingRecord() })
        .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
      ddbMock.on(UpdateItemCommand).resolves({});

      mockPromotionCodesList.mockResolvedValue({ data: [{ id: 'promo_xxx' }] });
      mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

      const event = buildEvent({
        userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
        method: 'POST',
        rawPath: '/api/billing/activate',
        body: JSON.stringify({ promotionCode: 'WELCOME20' }),
      });
      await handler(event, {} as never);

      expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
      expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
        customer: 'cus_test_123',
        items: [{ price: 'price_test_fake' }],
        default_payment_method: 'pm_test_789',
        discounts: [{ promotion_code: 'promo_xxx' }],
        expand: ['latest_invoice.payment_intent', 'default_payment_method'],
      });
    });

    it('includes discounts in subscriptions.create when reactivating a canceled subscription', async () => {
      ddbMock
        .on(GetItemCommand)
        .resolvesOnce({
          Item: buildBillingRecord({
            subscriptionId: 'sub_canceled_old',
            subscriptionStatus: SubscriptionStatus.Canceled,
          }),
        })
        .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
      ddbMock.on(UpdateItemCommand).resolves({});

      mockPromotionCodesList.mockResolvedValue({ data: [{ id: 'promo_xxx' }] });
      mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

      const event = buildEvent({
        userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
        method: 'POST',
        rawPath: '/api/billing/activate',
        body: JSON.stringify({ promotionCode: 'WELCOME20' }),
      });
      await handler(event, {} as never);

      expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
      expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
        customer: 'cus_test_123',
        items: [{ price: 'price_test_fake' }],
        default_payment_method: 'pm_test_789',
        discounts: [{ promotion_code: 'promo_xxx' }],
        expand: ['latest_invoice.payment_intent', 'default_payment_method'],
      });
      expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    });

    it('returns 400 with INVALID_PROMOTION_CODE when Stripe has no active code matching', async () => {
      ddbMock.on(GetItemCommand).resolvesOnce({
        Item: buildBillingRecord({
          subscriptionId: 'sub_trial_123',
          subscriptionStatus: SubscriptionStatus.Trialing,
        }),
      });
      ddbMock.on(UpdateItemCommand).resolves({});

      mockPromotionCodesList.mockResolvedValue({ data: [] });

      const event = buildEvent({
        userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
        method: 'POST',
        rawPath: '/api/billing/activate',
        body: JSON.stringify({ promotionCode: 'BOGUS123' }),
      });
      const result = await handler(event, {} as never);
      const body = JSON.parse((result as { body: string }).body);

      expect((result as { statusCode: number }).statusCode).toBe(400);
      expect(body.code).toBe('INVALID_PROMOTION_CODE');
      expect(body.message).toContain('Invalid or expired');
      expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
      expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('returns 400 from Zod for a malformed promo code without calling Stripe', async () => {
      const event = buildEvent({
        userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
        method: 'POST',
        rawPath: '/api/billing/activate',
        body: JSON.stringify({ promotionCode: 'ab' }),
      });
      const result = await handler(event, {} as never);
      const body = JSON.parse((result as { body: string }).body);

      expect((result as { statusCode: number }).statusCode).toBe(400);
      expect(Array.isArray(body.issues)).toBe(true);
      expect(mockPromotionCodesList).not.toHaveBeenCalled();
      expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
      expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    });

    it('does not call promotionCodes.list and does not add a discount-apply update when no promo code is sent', async () => {
      ddbMock
        .on(GetItemCommand)
        .resolvesOnce({
          Item: buildBillingRecord({
            subscriptionId: 'sub_trial_123',
            subscriptionStatus: SubscriptionStatus.Trialing,
          }),
        })
        .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
      ddbMock.on(UpdateItemCommand).resolves({});

      mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

      const event = buildEvent({
        userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
        method: 'POST',
        rawPath: '/api/billing/activate',
      });
      await handler(event, {} as never);

      expect(mockPromotionCodesList).not.toHaveBeenCalled();
      expect(mockSubscriptionsUpdate).toHaveBeenCalledTimes(2);
    });

    it('applies discounts on the saved-payment-method reactivation create', async () => {
      ddbMock
        .on(GetItemCommand)
        .resolvesOnce({
          Item: buildBillingRecord({
            subscriptionStatus: SubscriptionStatus.Canceled,
            subscriptionId: 'sub_canceled_old',
            paymentMethodId: 'pm_saved_1',
          }),
        })
        .resolvesOnce(orgProfileWithTenant('aurora-t-1'));
      ddbMock.on(UpdateItemCommand).resolves({});

      mockPromotionCodesList.mockResolvedValue({ data: [{ id: 'promo_xxx' }] });
      mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

      const event = buildEvent({
        userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
        method: 'POST',
        rawPath: '/api/billing/activate',
        body: JSON.stringify({ useSavedPaymentMethod: true, promotionCode: 'WELCOME20' }),
      });
      await handler(event, {} as never);

      expect(mockSetupIntentsList).not.toHaveBeenCalled();
      expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
      expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
        customer: 'cus_test_123',
        items: [{ price: 'price_test_fake' }],
        default_payment_method: 'pm_saved_1',
        discounts: [{ promotion_code: 'promo_xxx' }],
        expand: ['latest_invoice.payment_intent', 'default_payment_method'],
      });
    });
  });
});
