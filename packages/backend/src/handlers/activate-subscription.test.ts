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

// Mocked rather than stubbed through ddbMock: the fence read would otherwise
// shift every resolvesOnce sequence below by one.
const mockIsOrgDeleting = vi.fn(
  async (_orgId: string, _options?: { consistent?: boolean }) => false,
);
vi.mock('../lib/org-profile.js', async () => ({
  ...(await vi.importActual<typeof import('../lib/org-profile.js')>('../lib/org-profile.js')),
  isOrgDeleting: (...args: Parameters<typeof mockIsOrgDeleting>) => mockIsOrgDeleting(...args),
}));

// The orchestrator registry instantiates real clients at import time; mock it
// so the otherwise-real region-helpers module can be loaded below.
vi.mock('../lib/service-orchestrator-registry.js', () => ({
  getAvailableOrchestrators: () => [],
}));

const mockSyncTenantStatusInProvisionedRegions = vi.fn();
vi.mock('../lib/region-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/region-helpers.js')>()),
  syncTenantStatusInProvisionedRegions: (...args: unknown[]) =>
    mockSyncTenantStatusInProvisionedRegions(...args),
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

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './activate-subscription.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The subscription row's key, and the dead `CUSTOMER#` key the cleanup step deletes. */
const ORG_KEY = { pk: { S: 'ORG#org-1' }, sk: { S: 'SUBSCRIPTION' } };
const LEGACY_KEY = { pk: { S: 'CUSTOMER#user-1' }, sk: { S: 'SUBSCRIPTION' } };

/** The org's row — the only row a read can land on. */
function buildBillingRecord(overrides?: Record<string, unknown>) {
  const base: Record<string, unknown> = {
    pk: ORG_KEY.pk.S,
    sk: 'SUBSCRIPTION',
    stripeCustomerId: 'cus_test_123',
    orgId: 'org-1',
    userId: 'user-1',
    subscriptionStatus: SubscriptionStatus.Trialing,
    ...overrides,
  };
  for (const key of Object.keys(base)) {
    if (base[key] === undefined) delete base[key];
  }
  return marshall(base);
}

/** The partition keys the updates landed on, in the order the store wrote them. */
function updatedKeys() {
  return ddbMock.commandCalls(UpdateItemCommand).map((call) => call.args[0].input.Key?.pk?.S);
}

function orgProfileWithTenant(tenantId: string) {
  return {
    Item: {
      pk: { S: 'ORG#org-1' },
      sk: { S: 'PROFILE' },
      auroraTenantId: { S: tenantId },
      auroraSetupStatus: { S: FINAL_SETUP_STATUS },
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
    // Both ends of the period, the way Stripe returns them.
    items: { data: [{ current_period_start: 1698531200, current_period_end: 1701209600 }] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('activate-subscription baseHandler', () => {
  beforeEach(() => {
    ddbMock.reset();
    mockSetupIntentsList.mockReset();
    mockSubscriptionsCreate.mockReset();
    mockSubscriptionsUpdate.mockReset();
    mockPromotionCodesList.mockReset();
    mockSyncTenantStatusInProvisionedRegions.mockReset();

    mockSetupIntentsList.mockResolvedValue({
      data: [{ status: 'succeeded', payment_method: 'pm_test_789' }],
    });
    mockSyncTenantStatusInProvisionedRegions.mockResolvedValue([]);
    mockIsOrgDeleting.mockResolvedValue(false);
    // The billing read asks both keys at once. Absent unless a test says
    // otherwise, so a row only exists where the test put one.
    ddbMock.on(GetItemCommand).resolves({});
  });

  // A subscription created here is billable and postdates teardown's snapshot
  // of stripeCustomerId, so nothing would ever cancel it.
  it('410s without touching Stripe when the org is being deleted', async () => {
    mockIsOrgDeleting.mockResolvedValue(true);

    const event = buildEvent({
      userInfo: { userId: 'user-1', orgId: 'org-1' },
      body: JSON.stringify({}),
    });

    const result = await baseHandler(event);

    expect((result as { statusCode: number }).statusCode).toBe(410);
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
  });

  it('updates existing trial subscription when subscriptionId exists', async () => {
    // Record has subscriptionId from billing-trial-setup
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({
        Item: buildBillingRecord({
          subscriptionId: 'sub_trial_123',
          subscriptionStatus: SubscriptionStatus.Trialing,
        }),
      })
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await baseHandler(event);
    const body = JSON.parse((result as { body: string }).body);

    // Should call update twice (attach PM, then end trial), NOT create
    expect(mockSubscriptionsUpdate).toHaveBeenCalledTimes(2);
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();

    expect(body.subscription.status).toBe(SubscriptionStatus.Active);
  });

  it("activates the org subscription rather than the one on the caller's legacy row", async () => {
    // Billing belongs to the org, so a legacy row the caller happens to own
    // must not decide which Stripe customer gets charged.
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({
        Item: buildBillingRecord({
          stripeCustomerId: 'cus_org_1',
          subscriptionId: 'sub_org_1',
          subscriptionStatus: SubscriptionStatus.Trialing,
        }),
      })
      .on(GetItemCommand, { Key: LEGACY_KEY })
      .resolves({
        Item: buildBillingRecord({
          pk: LEGACY_KEY.pk.S,
          stripeCustomerId: 'cus_legacy_9',
          subscriptionId: 'sub_legacy_9',
        }),
      });
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    await baseHandler(event);

    expect(mockSubscriptionsUpdate).toHaveBeenNthCalledWith(1, 'sub_org_1', {
      default_payment_method: 'pm_test_789',
    });
    expect(mockSetupIntentsList).toHaveBeenCalledWith({ customer: 'cus_org_1', limit: 1 });
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(1);
  });

  it('refuses to activate when the org has no billing row of its own', async () => {
    // A `CUSTOMER#` row the cleanup step has not deleted yet cannot stand in
    // for the org's: activating off it would charge a Stripe customer the org
    // does not own.
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({})
      .on(GetItemCommand, { Key: LEGACY_KEY })
      .resolves({
        Item: buildBillingRecord({ pk: LEGACY_KEY.pk.S, subscriptionId: 'sub_legacy_9' }),
      });

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await baseHandler(event);
    const body = JSON.parse((result as { body: string }).body);

    expect((result as { statusCode: number }).statusCode).toBe(400);
    expect(body.message).toContain('No billing record found');
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(mockSyncTenantStatusInProvisionedRegions).not.toHaveBeenCalled();
  });

  it('unlocks every provisioned region on activation', async () => {
    ddbMock.on(GetItemCommand, { Key: ORG_KEY }).resolves({
      Item: buildBillingRecord({
        subscriptionId: 'sub_trial_123',
        subscriptionStatus: SubscriptionStatus.Trialing,
      }),
    });
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    await baseHandler(event);

    expect(mockSyncTenantStatusInProvisionedRegions).toHaveBeenCalledWith('org-1', 'active');
  });

  it('attaches payment method before ending trial to prevent cancellation', async () => {
    // This test covers a bug where sending trial_end and default_payment_method
    // in a single call caused Stripe's missing_payment_method:'cancel' behavior
    // to fire before the payment method was fully attached, canceling the subscription.
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({
        Item: buildBillingRecord({
          subscriptionId: 'sub_trial_123',
          subscriptionStatus: SubscriptionStatus.Trialing,
        }),
      })
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    await baseHandler(event);

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
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({ Item: buildBillingRecord() })
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await baseHandler(event);
    const body = JSON.parse((result as { body: string }).body);

    // Should call create, NOT update
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
      customer: 'cus_test_123',
      items: [{ price: 'price_test_fake' }],
      default_payment_method: 'pm_test_789',
      metadata: { userId: 'user-1', orgId: 'org-1' },
      expand: ['latest_invoice.payment_intent', 'default_payment_method'],
    });
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();

    expect(body.subscription.status).toBe(SubscriptionStatus.Active);
  });

  it('creates a new subscription when reactivating a canceled subscription (GracePeriod)', async () => {
    // Record retains the stale subscriptionId from the canceled Stripe subscription;
    // the webhook clears it later via customer.subscription.created.
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({
        Item: buildBillingRecord({
          subscriptionId: 'sub_canceled_old',
          subscriptionStatus: SubscriptionStatus.GracePeriod,
        }),
      })
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await baseHandler(event);
    const body = JSON.parse((result as { body: string }).body);

    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
      customer: 'cus_test_123',
      items: [{ price: 'price_test_fake' }],
      default_payment_method: 'pm_test_789',
      metadata: { userId: 'user-1', orgId: 'org-1' },
      expand: ['latest_invoice.payment_intent', 'default_payment_method'],
    });
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();

    expect(body.subscription.status).toBe(SubscriptionStatus.Active);
  });

  it('creates a new subscription when reactivating a fully canceled subscription (Canceled)', async () => {
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({
        Item: buildBillingRecord({
          subscriptionId: 'sub_canceled_old',
          subscriptionStatus: SubscriptionStatus.Canceled,
        }),
      })
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await baseHandler(event);
    const body = JSON.parse((result as { body: string }).body);

    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
      customer: 'cus_test_123',
      items: [{ price: 'price_test_fake' }],
      default_payment_method: 'pm_test_789',
      metadata: { userId: 'user-1', orgId: 'org-1' },
      expand: ['latest_invoice.payment_intent', 'default_payment_method'],
    });
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();

    expect(body.subscription.status).toBe(SubscriptionStatus.Active);
  });

  it('removes trialEndsAt when updating trial subscription (trial_end: now)', async () => {
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({ Item: buildBillingRecord({ subscriptionId: 'sub_trial_123' }) })
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    await baseHandler(event);

    // The billing update only, landing on the org row.
    expect(updatedKeys()).toStrictEqual([ORG_KEY.pk.S]);
    // trial_end: 'now' makes Stripe return active, so trialEndsAt should be removed
    expect(
      ddbMock.commandCalls(UpdateItemCommand).at(0)?.args[0].input.UpdateExpression as string,
    ).toContain('REMOVE trialEndsAt');
  });

  it('removes trialEndsAt when subscription is active', async () => {
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({ Item: buildBillingRecord() })
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    await baseHandler(event);

    // The billing update only, landing on the org row.
    expect(updatedKeys()).toStrictEqual([ORG_KEY.pk.S]);
    expect(
      ddbMock.commandCalls(UpdateItemCommand).at(0)?.args[0].input.UpdateExpression as string,
    ).toContain('REMOVE trialEndsAt');
  });

  it('returns 402 when subscription status is incomplete after activation (3DS pending)', async () => {
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({ Item: buildBillingRecord({ subscriptionId: 'sub_trial_123' }) });
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'incomplete' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await baseHandler(event);
    const body = JSON.parse((result as { body: string }).body);

    expect((result as { statusCode: number }).statusCode).toBe(402);
    expect(body.message).toContain('Additional authentication');

    // DynamoDB should NOT have been updated with the subscription status
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);

    // Aurora tenant should NOT have been unlocked
    expect(mockSyncTenantStatusInProvisionedRegions).not.toHaveBeenCalled();
  });

  it('returns 402 when subscription status is unpaid after activation', async () => {
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({ Item: buildBillingRecord({ subscriptionId: 'sub_trial_123' }) });
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'unpaid' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    const result = await baseHandler(event);

    expect((result as { statusCode: number }).statusCode).toBe(402);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(mockSyncTenantStatusInProvisionedRegions).not.toHaveBeenCalled();
  });

  // Turning the throw into a 500 is errorHandlerMiddleware's job, and its own
  // suite says so. What the handler owes is that a region left locked is not
  // reported to the caller as an activated subscription.
  it('propagates a failed tenant-status sync instead of answering success', async () => {
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({ Item: buildBillingRecord({ subscriptionId: 'sub_trial_123' }) });
    ddbMock.on(UpdateItemCommand).resolves({});
    mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));
    mockSyncTenantStatusInProvisionedRegions.mockResolvedValue([
      {
        orchestratorId: 'aurora',
        tenantId: 'aurora-t-1',
        outcome: 'error',
        cause: new Error('Aurora down'),
      },
    ]);

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
    });
    await expect(baseHandler(event)).rejects.toThrow('tenant status sync failed');
  });

  // ── useSavedPaymentMethod path ────────────────────────────────────

  it('reactivates a canceled subscription using the saved payment method (GracePeriod)', async () => {
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({
        Item: buildBillingRecord({
          subscriptionStatus: SubscriptionStatus.GracePeriod,
          subscriptionId: 'sub_canceled_old',
          paymentMethodId: 'pm_saved_1',
        }),
      })
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves(orgProfileWithTenant('aurora-t-1'));
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
    const result = await baseHandler(event);
    const body = JSON.parse((result as { body: string }).body);

    expect(mockSetupIntentsList).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
      customer: 'cus_test_123',
      items: [{ price: 'price_test_fake' }],
      default_payment_method: 'pm_saved_1',
      metadata: { userId: 'user-1', orgId: 'org-1' },
      expand: ['latest_invoice.payment_intent', 'default_payment_method'],
    });
    expect(body.subscription.status).toBe(SubscriptionStatus.Active);
  });

  it('reactivates a canceled subscription using the saved payment method (Canceled)', async () => {
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves({
        Item: buildBillingRecord({
          subscriptionStatus: SubscriptionStatus.Canceled,
          subscriptionId: 'sub_canceled_old',
          paymentMethodId: 'pm_saved_1',
        }),
      })
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves(orgProfileWithTenant('aurora-t-1'));
    ddbMock.on(UpdateItemCommand).resolves({});

    mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

    const event = buildEvent({
      userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
      method: 'POST',
      rawPath: '/api/billing/activate',
      body: JSON.stringify({ useSavedPaymentMethod: true }),
    });
    const result = await baseHandler(event);
    const body = JSON.parse((result as { body: string }).body);

    expect(mockSetupIntentsList).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(body.subscription.status).toBe(SubscriptionStatus.Active);
  });

  it('rejects useSavedPaymentMethod when subscription is active', async () => {
    ddbMock.on(GetItemCommand, { Key: ORG_KEY }).resolves({
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
    const result = await baseHandler(event);

    expect((result as { statusCode: number }).statusCode).toBe(400);
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
  });

  it('rejects useSavedPaymentMethod when subscription is trialing', async () => {
    ddbMock.on(GetItemCommand, { Key: ORG_KEY }).resolves({
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
    const result = await baseHandler(event);

    expect((result as { statusCode: number }).statusCode).toBe(400);
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('rejects useSavedPaymentMethod when no saved payment method exists', async () => {
    ddbMock.on(GetItemCommand, { Key: ORG_KEY }).resolves({
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
    const result = await baseHandler(event);
    const body = JSON.parse((result as { body: string }).body);

    expect((result as { statusCode: number }).statusCode).toBe(400);
    expect(body.message).toContain('No saved payment method');
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('returns 402 for useSavedPaymentMethod when subscription is incomplete', async () => {
    ddbMock.on(GetItemCommand, { Key: ORG_KEY }).resolves({
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
    const result = await baseHandler(event);

    expect((result as { statusCode: number }).statusCode).toBe(402);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(mockSyncTenantStatusInProvisionedRegions).not.toHaveBeenCalled();
  });

  // ── promotion code ────────────────────────────────────────────────────

  describe('promotion code', () => {
    it('applies the discount in its own update between PM-attach and trial-end (trial→paid)', async () => {
      ddbMock
        .on(GetItemCommand, { Key: ORG_KEY })
        .resolves({
          Item: buildBillingRecord({
            subscriptionId: 'sub_trial_123',
            subscriptionStatus: SubscriptionStatus.Trialing,
          }),
        })
        .on(GetItemCommand, { TableName: 'UserInfoTable' })
        .resolves(orgProfileWithTenant('aurora-t-1'));
      ddbMock.on(UpdateItemCommand).resolves({});

      mockPromotionCodesList.mockResolvedValue({ data: [{ id: 'promo_xxx' }] });
      mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

      const event = buildEvent({
        userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
        method: 'POST',
        rawPath: '/api/billing/activate',
        body: JSON.stringify({ promotionCode: 'WELCOME20' }),
      });
      await baseHandler(event);

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
        .on(GetItemCommand, { Key: ORG_KEY })
        .resolves({ Item: buildBillingRecord() })
        .on(GetItemCommand, { TableName: 'UserInfoTable' })
        .resolves(orgProfileWithTenant('aurora-t-1'));
      ddbMock.on(UpdateItemCommand).resolves({});

      mockPromotionCodesList.mockResolvedValue({ data: [{ id: 'promo_xxx' }] });
      mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

      const event = buildEvent({
        userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
        method: 'POST',
        rawPath: '/api/billing/activate',
        body: JSON.stringify({ promotionCode: 'WELCOME20' }),
      });
      await baseHandler(event);

      expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
      expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
        customer: 'cus_test_123',
        items: [{ price: 'price_test_fake' }],
        default_payment_method: 'pm_test_789',
        metadata: { userId: 'user-1', orgId: 'org-1' },
        discounts: [{ promotion_code: 'promo_xxx' }],
        expand: ['latest_invoice.payment_intent', 'default_payment_method'],
      });
    });

    it('includes discounts in subscriptions.create when reactivating a canceled subscription', async () => {
      ddbMock
        .on(GetItemCommand, { Key: ORG_KEY })
        .resolves({
          Item: buildBillingRecord({
            subscriptionId: 'sub_canceled_old',
            subscriptionStatus: SubscriptionStatus.Canceled,
          }),
        })
        .on(GetItemCommand, { TableName: 'UserInfoTable' })
        .resolves(orgProfileWithTenant('aurora-t-1'));
      ddbMock.on(UpdateItemCommand).resolves({});

      mockPromotionCodesList.mockResolvedValue({ data: [{ id: 'promo_xxx' }] });
      mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

      const event = buildEvent({
        userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
        method: 'POST',
        rawPath: '/api/billing/activate',
        body: JSON.stringify({ promotionCode: 'WELCOME20' }),
      });
      await baseHandler(event);

      expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
      expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
        customer: 'cus_test_123',
        items: [{ price: 'price_test_fake' }],
        default_payment_method: 'pm_test_789',
        metadata: { userId: 'user-1', orgId: 'org-1' },
        discounts: [{ promotion_code: 'promo_xxx' }],
        expand: ['latest_invoice.payment_intent', 'default_payment_method'],
      });
      expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    });

    it('returns 400 with INVALID_PROMOTION_CODE when Stripe has no active code matching', async () => {
      ddbMock.on(GetItemCommand, { Key: ORG_KEY }).resolves({
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
      const result = await baseHandler(event);
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
      const result = await baseHandler(event);
      const body = JSON.parse((result as { body: string }).body);

      expect((result as { statusCode: number }).statusCode).toBe(400);
      expect(Array.isArray(body.issues)).toBe(true);
      expect(mockPromotionCodesList).not.toHaveBeenCalled();
      expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
      expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    });

    it('does not call promotionCodes.list and does not add a discount-apply update when no promo code is sent', async () => {
      ddbMock
        .on(GetItemCommand, { Key: ORG_KEY })
        .resolves({
          Item: buildBillingRecord({
            subscriptionId: 'sub_trial_123',
            subscriptionStatus: SubscriptionStatus.Trialing,
          }),
        })
        .on(GetItemCommand, { TableName: 'UserInfoTable' })
        .resolves(orgProfileWithTenant('aurora-t-1'));
      ddbMock.on(UpdateItemCommand).resolves({});

      mockSubscriptionsUpdate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

      const event = buildEvent({
        userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
        method: 'POST',
        rawPath: '/api/billing/activate',
      });
      await baseHandler(event);

      expect(mockPromotionCodesList).not.toHaveBeenCalled();
      expect(mockSubscriptionsUpdate).toHaveBeenCalledTimes(2);
    });

    it('applies discounts on the saved-payment-method reactivation create', async () => {
      ddbMock
        .on(GetItemCommand, { Key: ORG_KEY })
        .resolves({
          Item: buildBillingRecord({
            subscriptionStatus: SubscriptionStatus.Canceled,
            subscriptionId: 'sub_canceled_old',
            paymentMethodId: 'pm_saved_1',
          }),
        })
        .on(GetItemCommand, { TableName: 'UserInfoTable' })
        .resolves(orgProfileWithTenant('aurora-t-1'));
      ddbMock.on(UpdateItemCommand).resolves({});

      mockPromotionCodesList.mockResolvedValue({ data: [{ id: 'promo_xxx' }] });
      mockSubscriptionsCreate.mockResolvedValue(mockSubscriptionResponse({ status: 'active' }));

      const event = buildEvent({
        userInfo: { userId: 'user-1', email: 'test@example.com', orgId: 'org-1' },
        method: 'POST',
        rawPath: '/api/billing/activate',
        body: JSON.stringify({ useSavedPaymentMethod: true, promotionCode: 'WELCOME20' }),
      });
      await baseHandler(event);

      expect(mockSetupIntentsList).not.toHaveBeenCalled();
      expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
      expect(mockSubscriptionsCreate).toHaveBeenCalledWith({
        customer: 'cus_test_123',
        items: [{ price: 'price_test_fake' }],
        default_payment_method: 'pm_saved_1',
        metadata: { userId: 'user-1', orgId: 'org-1' },
        discounts: [{ promotion_code: 'promo_xxx' }],
        expand: ['latest_invoice.payment_intent', 'default_payment_method'],
      });
    });
  });
});
