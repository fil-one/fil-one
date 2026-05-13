import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { buildEvent } from '../test/lambda-test-utilities.js';
import { type MetricEvent, reportMetric } from '../lib/metrics.js';
import { SubscriptionStatus } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockUpdateTenantStatus = vi.fn();
vi.mock('../lib/aurora-backoffice.js', () => ({
  updateTenantStatus: (...args: unknown[]) => mockUpdateTenantStatus(...args),
}));

vi.mock('../lib/org-setup-status.js', () => ({
  isOrgSetupComplete: (status: string | undefined) => status === 'AURORA_S3_ACCESS_KEY_CREATED',
}));

const mockConstructEvent = vi.fn();
const mockCustomersRetrieve = vi.fn();
const mockPaymentMethodsRetrieve = vi.fn();

vi.mock('../lib/stripe-client.js', () => ({
  getStripeClient: () => ({
    webhooks: { constructEvent: mockConstructEvent },
    customers: { retrieve: mockCustomersRetrieve },
    paymentMethods: { retrieve: mockPaymentMethodsRetrieve },
  }),
  getWebhookSecret: vi.fn().mockResolvedValue('whsec_test_fake'),
}));

vi.mock('../lib/metrics.js', () => ({
  reportMetric: vi.fn(),
}));

const reportMetricMock = vi.mocked(reportMetric);

const ddbMock = mockClient(DynamoDBClient);

import { handler } from './stripe-webhook.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TABLE_NAME = 'BillingTable';
const MOCK_USER_ID = 'test-user-uuid';
const MOCK_CUSTOMER_ID = 'cus_test_123';
const MOCK_SUBSCRIPTION_ID = 'sub_test_456';
const MOCK_EVENT_ID = 'evt_test_789';

function buildWebhookEvent(body: string, opts?: { isBase64Encoded?: boolean }) {
  const evt = buildEvent();
  evt.headers['stripe-signature'] = 'sig_test';
  evt.body = opts?.isBase64Encoded ? Buffer.from(body).toString('base64') : body;
  evt.isBase64Encoded = opts?.isBase64Encoded ?? false;
  return evt;
}

function mockSubscription(overrides?: Record<string, unknown>) {
  return {
    id: MOCK_SUBSCRIPTION_ID,
    customer: MOCK_CUSTOMER_ID,
    status: 'active',
    metadata: { userId: MOCK_USER_ID },
    items: {
      data: [
        {
          current_period_start: 1600000000,
          current_period_end: 1700000000,
        },
      ],
    },
    ...overrides,
  };
}

function mockInvoice(overrides?: Record<string, unknown>) {
  return {
    id: 'in_test_001',
    customer: MOCK_CUSTOMER_ID,
    ...overrides,
  };
}

function setupStripeEvent(type: string, object: unknown) {
  mockConstructEvent.mockReturnValue({
    id: MOCK_EVENT_ID,
    type,
    data: { object },
  });
}

function setupCustomerRetrieve(userId?: string) {
  mockCustomersRetrieve.mockResolvedValue({
    id: MOCK_CUSTOMER_ID,
    deleted: false,
    metadata: { userId: userId ?? MOCK_USER_ID },
  });
}

function setupDeletedCustomerRetrieve() {
  mockCustomersRetrieve.mockResolvedValue({
    id: MOCK_CUSTOMER_ID,
    deleted: true,
  });
}

const MOCK_PM_ID = 'pm_test_abc';
const MOCK_PM_LAST4 = '3184';
const MOCK_PM_BRAND = 'visa';
const MOCK_PM_EXP_MONTH = 12;
const MOCK_PM_EXP_YEAR = 2030;

function mockPaymentMethod(overrides?: Record<string, unknown>) {
  return {
    id: MOCK_PM_ID,
    card: {
      last4: MOCK_PM_LAST4,
      brand: MOCK_PM_BRAND,
      exp_month: MOCK_PM_EXP_MONTH,
      exp_year: MOCK_PM_EXP_YEAR,
    },
    ...overrides,
  };
}

function mockCustomerObject(overrides?: Record<string, unknown>) {
  return {
    id: MOCK_CUSTOMER_ID,
    metadata: { userId: MOCK_USER_ID },
    invoice_settings: {
      default_payment_method: mockPaymentMethod(),
    },
    ...overrides,
  };
}

function setupPaymentMethodsRetrieve() {
  mockPaymentMethodsRetrieve.mockResolvedValue(mockPaymentMethod());
}

const MOCK_ORG_ID = 'test-org-uuid';
const MOCK_AURORA_TENANT_ID = 'aurora-tenant-123';

function setupAuroraTenantResolution() {
  ddbMock
    .on(GetItemCommand, {
      TableName: 'BillingTable',
      Key: { pk: { S: `CUSTOMER#${MOCK_USER_ID}` }, sk: { S: 'SUBSCRIPTION' } },
    })
    .resolves({
      Item: marshall({ pk: `CUSTOMER#${MOCK_USER_ID}`, sk: 'SUBSCRIPTION', orgId: MOCK_ORG_ID }),
    });
  ddbMock
    .on(GetItemCommand, {
      TableName: 'UserInfoTable',
      Key: { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'PROFILE' } },
    })
    .resolves({
      Item: marshall({
        pk: `ORG#${MOCK_ORG_ID}`,
        sk: 'PROFILE',
        auroraTenantId: MOCK_AURORA_TENANT_ID,
        setupStatus: 'AURORA_S3_ACCESS_KEY_CREATED',
      }),
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stripe-webhook handler', () => {
  function dunningEmissions(): MetricEvent[] {
    return reportMetricMock.mock.calls
      .map(([event]) => event)
      .filter((e) => (e as { DunningEscalation?: unknown }).DunningEscalation === 1);
  }

  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});
    ddbMock.on(DeleteItemCommand).resolves({});
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    mockConstructEvent.mockReset();
    mockCustomersRetrieve.mockReset();
    mockPaymentMethodsRetrieve.mockReset();
    mockUpdateTenantStatus.mockReset();
    mockUpdateTenantStatus.mockResolvedValue(undefined);
    reportMetricMock.mockReset();
  });

  // -----------------------------------------------------------------------
  // 1. Signature verification
  // -----------------------------------------------------------------------
  describe('signature verification', () => {
    it('returns 400 when stripe-signature header missing', async () => {
      const evt = buildEvent();
      // No stripe-signature header
      const result = await handler(evt);
      expect(result).toEqual({
        statusCode: 400,
        body: JSON.stringify({ message: 'Missing stripe-signature header' }),
      });
    });

    it('returns 400 when constructEvent throws (invalid signature)', async () => {
      mockConstructEvent.mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      const evt = buildWebhookEvent('{}');
      const result = await handler(evt);
      expect(result).toEqual({
        statusCode: 400,
        body: JSON.stringify({ message: 'Invalid signature' }),
      });
    });

    it('decodes base64 body before verification', async () => {
      const rawBody = JSON.stringify({ test: true });
      setupStripeEvent('unknown.event', {});

      const evt = buildWebhookEvent(rawBody, { isBase64Encoded: true });
      await handler(evt);

      expect(mockConstructEvent).toHaveBeenCalledWith(rawBody, 'sig_test', 'whsec_test_fake');
    });
  });

  // -----------------------------------------------------------------------
  // 2. Idempotency
  // -----------------------------------------------------------------------
  describe('idempotency', () => {
    it('returns 200 without processing when event already handled', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());
      const condError = new Error('Conditional check failed');
      (condError as { name: string }).name = 'ConditionalCheckFailedException';
      ddbMock.on(PutItemCommand).rejects(condError);

      const result = await handler(buildWebhookEvent('{}'));
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });

      // Should NOT have called UpdateItemCommand
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('records idempotency PutItem before processing (with TTL ~30 days)', async () => {
      setupStripeEvent('unknown.event', {});

      const before = Math.floor(Date.now() / 1000);
      await handler(buildWebhookEvent('{}'));
      const after = Math.floor(Date.now() / 1000);

      const putCalls = ddbMock.commandCalls(PutItemCommand);
      expect(putCalls).toHaveLength(1);

      const input = putCalls[0].args[0].input;
      expect(input).toStrictEqual({
        TableName: TABLE_NAME,
        ConditionExpression: 'attribute_not_exists(pk)',
        Item: {
          pk: { S: `WEBHOOK#${MOCK_EVENT_ID}` },
          sk: { S: 'EVENT' },
          eventType: { S: 'unknown.event' },
          processedAt: { S: expect.any(String) },
          ttl: { N: expect.any(String) },
        },
      });

      const ttl = Number(input.Item!.ttl.N);
      const thirtyDays = 30 * 24 * 60 * 60;
      expect(ttl).toBeGreaterThanOrEqual(before + thirtyDays);
      expect(ttl).toBeLessThanOrEqual(after + thirtyDays + 1);
    });

    it('deletes idempotency record when processing fails', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());
      ddbMock.on(UpdateItemCommand).rejects(new Error('DynamoDB error'));

      const result = await handler(buildWebhookEvent('{}'));
      expect(result).toEqual({
        statusCode: 500,
        body: JSON.stringify({ message: 'Processing error' }),
      });

      const deleteCalls = ddbMock.commandCalls(DeleteItemCommand);
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].args[0].input).toStrictEqual({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: `WEBHOOK#${MOCK_EVENT_ID}` },
          sk: { S: 'EVENT' },
        },
      });
    });

    it('returns 500 even if delete of idempotency record fails', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());
      ddbMock.on(UpdateItemCommand).rejects(new Error('DynamoDB error'));
      ddbMock.on(DeleteItemCommand).rejects(new Error('Delete failed'));

      const result = await handler(buildWebhookEvent('{}'));
      expect(result).toEqual({
        statusCode: 500,
        body: JSON.stringify({ message: 'Processing error' }),
      });
    });
  });

  // -----------------------------------------------------------------------
  // 3. customer.subscription.created
  // -----------------------------------------------------------------------
  describe('customer.subscription.created', () => {
    it('updates billing record using subscription.metadata.userId', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());

      const result = await handler(buildWebhookEvent('{}'));

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toStrictEqual({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: `CUSTOMER#${MOCK_USER_ID}` },
          sk: { S: 'SUBSCRIPTION' },
        },
        UpdateExpression:
          'SET subscriptionId = :subId, subscriptionStatus = :status, currentPeriodEnd = :periodEnd, currentPeriodStart = :periodStart, updatedAt = :now REMOVE gracePeriodEndsAt, canceledAt',
        ExpressionAttributeValues: {
          ':subId': { S: MOCK_SUBSCRIPTION_ID },
          ':status': { S: 'active' },
          ':periodStart': { S: new Date(1600000000 * 1000).toISOString() },
          ':periodEnd': { S: new Date(1700000000 * 1000).toISOString() },
          ':now': { S: expect.any(String) },
        },
      });
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('falls back to customer.metadata.userId when subscription metadata empty', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription({ metadata: {} }));
      setupCustomerRetrieve('fallback-user');

      const result = await handler(buildWebhookEvent('{}'));

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          Key: {
            pk: { S: 'CUSTOMER#fallback-user' },
            sk: { S: 'SUBSCRIPTION' },
          },
        }),
      );
      expect(mockCustomersRetrieve).toHaveBeenCalledWith(MOCK_CUSTOMER_ID);
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('skips when customer is deleted (fallback path)', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription({ metadata: {} }));
      setupDeletedCustomerRetrieve();

      const result = await handler(buildWebhookEvent('{}'));
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('skips when neither metadata source has userId', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription({ metadata: {} }));
      mockCustomersRetrieve.mockResolvedValue({
        id: MOCK_CUSTOMER_ID,
        deleted: false,
        metadata: {},
      });

      const result = await handler(buildWebhookEvent('{}'));
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('handles string customer ID via getCustomerIdString', async () => {
      setupStripeEvent(
        'customer.subscription.created',
        mockSubscription({ customer: 'cus_string_id' }),
      );

      await handler(buildWebhookEvent('{}'));
      // No error thrown, processed correctly
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
    });

    it('handles Customer object instead of string', async () => {
      setupStripeEvent(
        'customer.subscription.created',
        mockSubscription({
          customer: { id: 'cus_obj_id', deleted: false },
        }),
      );

      await handler(buildWebhookEvent('{}'));
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
    });

    it('handles DeletedCustomer object', async () => {
      setupStripeEvent(
        'customer.subscription.created',
        mockSubscription({
          metadata: {},
          customer: { id: 'cus_del_id', deleted: true },
        }),
      );
      setupDeletedCustomerRetrieve();

      const result = await handler(buildWebhookEvent('{}'));
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('passes through non-active subscription status', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription({ status: 'past_due' }));

      const result = await handler(buildWebhookEvent('{}'));

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':status': { S: 'past_due' },
          }),
        }),
      );
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('skips DDB update when Stripe status is incomplete (unmappable)', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setupStripeEvent('customer.subscription.created', mockSubscription({ status: 'incomplete' }));

      const result = await handler(buildWebhookEvent('{}'));

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalledWith(
        '[stripe-webhook] Unmappable Stripe status, skipping update',
        expect.objectContaining({ stripeStatus: 'incomplete' }),
      );
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
      consoleSpy.mockRestore();
    });

    it('maps incomplete_expired to canceled', async () => {
      setupStripeEvent(
        'customer.subscription.created',
        mockSubscription({ status: 'incomplete_expired' }),
      );

      const result = await handler(buildWebhookEvent('{}'));

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':status': { S: SubscriptionStatus.Canceled },
          }),
        }),
      );
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('maps unpaid to past_due', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription({ status: 'unpaid' }));

      const result = await handler(buildWebhookEvent('{}'));

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':status': { S: SubscriptionStatus.PastDue },
          }),
        }),
      );
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('falls back to customer lookup when userId is empty string', async () => {
      setupStripeEvent(
        'customer.subscription.created',
        mockSubscription({ metadata: { userId: '' } }),
      );
      setupCustomerRetrieve('fallback-user');

      const result = await handler(buildWebhookEvent('{}'));

      expect(mockCustomersRetrieve).toHaveBeenCalledWith(MOCK_CUSTOMER_ID);
      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          Key: {
            pk: { S: 'CUSTOMER#fallback-user' },
            sk: { S: 'SUBSCRIPTION' },
          },
        }),
      );
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });
  });

  // -----------------------------------------------------------------------
  // 4. customer.subscription.updated
  // -----------------------------------------------------------------------
  describe('customer.subscription.updated', () => {
    it('processes same as created (UpdateItemCommand with correct key/values)', async () => {
      setupStripeEvent('customer.subscription.updated', mockSubscription());

      const result = await handler(buildWebhookEvent('{}'));

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toStrictEqual({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: `CUSTOMER#${MOCK_USER_ID}` },
          sk: { S: 'SUBSCRIPTION' },
        },
        UpdateExpression:
          'SET subscriptionId = :subId, subscriptionStatus = :status, currentPeriodEnd = :periodEnd, currentPeriodStart = :periodStart, updatedAt = :now REMOVE gracePeriodEndsAt, canceledAt',
        ExpressionAttributeValues: {
          ':subId': { S: MOCK_SUBSCRIPTION_ID },
          ':status': { S: 'active' },
          ':periodStart': { S: new Date(1600000000 * 1000).toISOString() },
          ':periodEnd': { S: new Date(1700000000 * 1000).toISOString() },
          ':now': { S: expect.any(String) },
        },
      });
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('sets currentPeriodEnd from subscription.items.data[0].current_period_end', async () => {
      setupStripeEvent(
        'customer.subscription.updated',
        mockSubscription({
          items: { data: [{ current_period_end: 1800000000 }] },
        }),
      );

      const result = await handler(buildWebhookEvent('{}'));

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':periodEnd': { S: new Date(1800000000 * 1000).toISOString() },
          }),
        }),
      );
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('handles empty items.data array (defaults to epoch 0)', async () => {
      setupStripeEvent(
        'customer.subscription.updated',
        mockSubscription({
          items: { data: [] },
        }),
      );

      const result = await handler(buildWebhookEvent('{}'));

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':periodEnd': { S: new Date(0).toISOString() },
          }),
        }),
      );
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });
  });

  // -----------------------------------------------------------------------
  // 4b. customer.updated
  // -----------------------------------------------------------------------
  describe('customer.updated', () => {
    let consoleSpy: MockInstance | undefined;

    afterEach(() => {
      consoleSpy?.mockRestore();
      consoleSpy = undefined;
    });

    it('updates payment method in DynamoDB when default_payment_method is expanded object', async () => {
      setupStripeEvent('customer.updated', mockCustomerObject());

      const result = await handler(buildWebhookEvent('{}'));

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toStrictEqual({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: `CUSTOMER#${MOCK_USER_ID}` },
          sk: { S: 'SUBSCRIPTION' },
        },
        UpdateExpression:
          'SET paymentMethodId = :pmId, paymentMethodLast4 = :last4, paymentMethodBrand = :brand, paymentMethodExpMonth = :expMonth, paymentMethodExpYear = :expYear, updatedAt = :now',
        ExpressionAttributeValues: {
          ':pmId': { S: MOCK_PM_ID },
          ':last4': { S: MOCK_PM_LAST4 },
          ':brand': { S: MOCK_PM_BRAND },
          ':expMonth': { N: String(MOCK_PM_EXP_MONTH) },
          ':expYear': { N: String(MOCK_PM_EXP_YEAR) },
          ':now': { S: expect.any(String) },
        },
        ConditionExpression: 'attribute_exists(pk)',
      });
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('fetches payment method via paymentMethods.retrieve when default_payment_method is a string ID', async () => {
      setupStripeEvent(
        'customer.updated',
        mockCustomerObject({
          invoice_settings: { default_payment_method: MOCK_PM_ID },
        }),
      );
      setupPaymentMethodsRetrieve();

      const result = await handler(buildWebhookEvent('{}'));

      expect(mockPaymentMethodsRetrieve).toHaveBeenCalledWith(MOCK_PM_ID);
      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':last4': { S: MOCK_PM_LAST4 },
          }),
        }),
      );
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('throws when customer has no userId in metadata', async () => {
      setupStripeEvent('customer.updated', mockCustomerObject({ metadata: {} }));

      const result = await handler(buildWebhookEvent('{}'));
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(result).toEqual({
        statusCode: 500,
        body: JSON.stringify({ message: 'Processing error' }),
      });

      const deleteCalls = ddbMock.commandCalls(DeleteItemCommand);
      expect(deleteCalls).toHaveLength(1);
    });

    it('skips update when default_payment_method is null', async () => {
      setupStripeEvent(
        'customer.updated',
        mockCustomerObject({
          invoice_settings: { default_payment_method: null },
        }),
      );

      const result = await handler(buildWebhookEvent('{}'));

      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });

      // This handler path should not perform any DynamoDB updates or deletes.
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
    });

    it('skips update for trial-creation customer.updated event (currency null → usd, no default_payment_method)', async () => {
      const TRIAL_USER_ID = '2bfd6596-4ccb-47a8-b508-bf64fdb44d4e';
      const TRIAL_ORG_ID = '7d352bd8-ed9e-4f2a-8ec3-6ba7ae356525';
      const TRIAL_CUSTOMER_ID = 'cus_UN4LxyuGMbKzKz';
      const TRIAL_EVENT_ID = 'evt_1TOKCkAQEKri8lBk4HwPEKWK';

      consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      mockConstructEvent.mockReturnValue({
        id: TRIAL_EVENT_ID,
        type: 'customer.updated',
        data: {
          object: {
            id: TRIAL_CUSTOMER_ID,
            object: 'customer',
            currency: 'usd',
            invoice_settings: {
              default_payment_method: null,
              custom_fields: null,
              footer: null,
              rendering_options: null,
            },
            metadata: {
              userId: TRIAL_USER_ID,
              orgId: TRIAL_ORG_ID,
            },
          },
          previous_attributes: { currency: null },
        },
      });

      const result = await handler(buildWebhookEvent('{}'));

      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });

      // This handler path should not perform any DynamoDB updates or deletes.
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('customer.updated without default_payment_method'),
        expect.objectContaining({ customerId: TRIAL_CUSTOMER_ID, userId: TRIAL_USER_ID }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // 5. customer.subscription.deleted
  // -----------------------------------------------------------------------
  describe('customer.subscription.deleted', () => {
    it('sets GracePeriod status with 30-day grace window', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      setupCustomerRetrieve();

      const before = Date.now();
      const result = await handler(buildWebhookEvent('{}'));
      const after = Date.now();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      expect(input).toStrictEqual({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: `CUSTOMER#${MOCK_USER_ID}` },
          sk: { S: 'SUBSCRIPTION' },
        },
        UpdateExpression:
          'SET subscriptionStatus = :status, canceledAt = :now, gracePeriodEndsAt = :grace, updatedAt = :now',
        ExpressionAttributeValues: {
          ':status': { S: SubscriptionStatus.GracePeriod },
          ':now': { S: expect.any(String) },
          ':grace': { S: expect.any(String) },
        },
      });

      const graceDate = new Date(input.ExpressionAttributeValues![':grace'].S!).getTime();
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      expect(graceDate).toBeGreaterThanOrEqual(before + thirtyDays - 5000);
      expect(graceDate).toBeLessThanOrEqual(after + thirtyDays + 5000);
      expect(mockCustomersRetrieve).toHaveBeenCalledWith(MOCK_CUSTOMER_ID);
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('sets GracePeriod status with 7-day grace window for trialing subscriptions', async () => {
      const futureTrialEnd = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
      setupStripeEvent(
        'customer.subscription.deleted',
        mockSubscription({ trial_end: futureTrialEnd }),
      );
      setupCustomerRetrieve();

      const before = Date.now();
      const result = await handler(buildWebhookEvent('{}'));
      const after = Date.now();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      const graceDate = new Date(input.ExpressionAttributeValues![':grace'].S!).getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      expect(graceDate).toBeGreaterThanOrEqual(before + sevenDays - 5000);
      expect(graceDate).toBeLessThanOrEqual(after + sevenDays + 5000);
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('skips when customer is deleted', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      setupDeletedCustomerRetrieve();

      await handler(buildWebhookEvent('{}'));
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('skips when customer has no userId', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      mockCustomersRetrieve.mockResolvedValue({
        id: MOCK_CUSTOMER_ID,
        deleted: false,
        metadata: {},
      });

      await handler(buildWebhookEvent('{}'));
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('calls updateTenantStatus WRITE_LOCKED and writes auroraTenantStatus to org profile', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      setupCustomerRetrieve();
      setupAuroraTenantResolution();

      const result = await handler(buildWebhookEvent('{}'));

      expect(mockUpdateTenantStatus).toHaveBeenCalledWith({
        tenantId: MOCK_AURORA_TENANT_ID,
        status: 'WRITE_LOCKED',
      });

      // Verify org profile update with auroraTenantStatus
      const orgProfileUpdate = ddbMock
        .commandCalls(UpdateItemCommand)
        .find(
          (c) =>
            c.args[0].input.TableName === 'UserInfoTable' &&
            c.args[0].input.ExpressionAttributeValues?.[':s']?.S === 'WRITE_LOCKED',
        );
      expect(orgProfileUpdate).toBeDefined();
      expect(orgProfileUpdate!.args[0].input.Key).toEqual({
        pk: { S: `ORG#${MOCK_ORG_ID}` },
        sk: { S: 'PROFILE' },
      });

      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('does not fail webhook when Aurora WRITE_LOCK fails', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      setupCustomerRetrieve();
      setupAuroraTenantResolution();
      mockUpdateTenantStatus.mockRejectedValue(new Error('Aurora API error'));

      const result = await handler(buildWebhookEvent('{}'));

      // DynamoDB update should still have happened
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
      // Org profile auroraTenantStatus must NOT be updated when updateTenantStatus fails
      const orgProfileUpdate = ddbMock
        .commandCalls(UpdateItemCommand)
        .find(
          (c) =>
            c.args[0].input.TableName === 'UserInfoTable' &&
            c.args[0].input.ExpressionAttributeValues?.[':s']?.S === 'WRITE_LOCKED',
        );
      expect(orgProfileUpdate).toBeUndefined();
      // Webhook should still return 200
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('skips Aurora call when billing record has no orgId', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      setupCustomerRetrieve();
      // GetItemCommand returns no orgId (default mock returns undefined Item)

      const result = await handler(buildWebhookEvent('{}'));

      expect(mockUpdateTenantStatus).not.toHaveBeenCalled();
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });
  });

  // -----------------------------------------------------------------------
  // 6. customer.subscription.trial_will_end
  // -----------------------------------------------------------------------
  describe('customer.subscription.trial_will_end', () => {
    it('logs only, no UpdateItemCommand, idempotency claimed upfront', async () => {
      setupStripeEvent('customer.subscription.trial_will_end', mockSubscription());

      const result = await handler(buildWebhookEvent('{}'));
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // 7. invoice.payment_succeeded
  // -----------------------------------------------------------------------
  describe('invoice.payment_succeeded', () => {
    it('sets Active status, REMOVEs gracePeriodEndsAt, lastPaymentFailedAt, and canceledAt', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      setupCustomerRetrieve();

      const result = await handler(buildWebhookEvent('{}'));

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);

      expect(updateCalls[0].args[0].input).toStrictEqual({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: `CUSTOMER#${MOCK_USER_ID}` },
          sk: { S: 'SUBSCRIPTION' },
        },
        UpdateExpression:
          'SET subscriptionStatus = :active, lastPaymentAt = :now, updatedAt = :now REMOVE gracePeriodEndsAt, lastPaymentFailedAt, canceledAt',
        ExpressionAttributeValues: {
          ':active': { S: SubscriptionStatus.Active },
          ':now': { S: expect.any(String) },
        },
        ReturnValues: 'ALL_OLD',
      });
      expect(mockCustomersRetrieve).toHaveBeenCalledWith(MOCK_CUSTOMER_ID);
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('skips when invoice.customer is null', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice({ customer: null }));

      await handler(buildWebhookEvent('{}'));
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('skips when customer is deleted', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      setupDeletedCustomerRetrieve();

      await handler(buildWebhookEvent('{}'));
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('skips when customer has no userId', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      mockCustomersRetrieve.mockResolvedValue({
        id: MOCK_CUSTOMER_ID,
        deleted: false,
        metadata: {},
      });

      await handler(buildWebhookEvent('{}'));
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('handles invoice with Customer object instead of string', async () => {
      setupStripeEvent(
        'invoice.payment_succeeded',
        mockInvoice({
          customer: { id: MOCK_CUSTOMER_ID, deleted: false },
        }),
      );
      setupCustomerRetrieve();

      const result = await handler(buildWebhookEvent('{}'));

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('calls updateTenantStatus ACTIVE and writes auroraTenantStatus to org profile', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      setupCustomerRetrieve();
      setupAuroraTenantResolution();

      const result = await handler(buildWebhookEvent('{}'));

      expect(mockUpdateTenantStatus).toHaveBeenCalledWith({
        tenantId: MOCK_AURORA_TENANT_ID,
        status: 'ACTIVE',
      });

      // Verify org profile update with auroraTenantStatus
      const orgProfileUpdate = ddbMock
        .commandCalls(UpdateItemCommand)
        .find(
          (c) =>
            c.args[0].input.TableName === 'UserInfoTable' &&
            c.args[0].input.ExpressionAttributeValues?.[':s']?.S === 'ACTIVE',
        );
      expect(orgProfileUpdate).toBeDefined();

      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('does not fail webhook when Aurora re-activation fails', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      setupCustomerRetrieve();
      setupAuroraTenantResolution();
      mockUpdateTenantStatus.mockRejectedValue(new Error('Aurora API error'));

      const result = await handler(buildWebhookEvent('{}'));

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
      // Org profile auroraTenantStatus must NOT be updated when updateTenantStatus fails
      const orgProfileUpdate = ddbMock
        .commandCalls(UpdateItemCommand)
        .find(
          (c) =>
            c.args[0].input.TableName === 'UserInfoTable' &&
            c.args[0].input.ExpressionAttributeValues?.[':s']?.S === 'ACTIVE',
        );
      expect(orgProfileUpdate).toBeUndefined();
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });
  });

  // -----------------------------------------------------------------------
  // 8. invoice.payment_failed
  // -----------------------------------------------------------------------
  describe('invoice.payment_failed', () => {
    it('sets PastDue status with lastPaymentFailedAt (no grace period)', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoice());
      setupCustomerRetrieve();

      const result = await handler(buildWebhookEvent('{}'));

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      expect(input).toStrictEqual({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: `CUSTOMER#${MOCK_USER_ID}` },
          sk: { S: 'SUBSCRIPTION' },
        },
        UpdateExpression:
          'SET subscriptionStatus = :status, lastPaymentFailedAt = :failedAt, updatedAt = :now',
        ExpressionAttributeValues: {
          ':status': { S: SubscriptionStatus.PastDue },
          ':failedAt': { S: expect.any(String) },
          ':now': { S: expect.any(String) },
        },
      });

      // Must NOT set gracePeriodEndsAt — Stripe Smart Retries handle the retry window
      expect(input.UpdateExpression).not.toContain('gracePeriodEndsAt');
      expect(mockCustomersRetrieve).toHaveBeenCalledWith(MOCK_CUSTOMER_ID);
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });

    it('skips when invoice.customer is null', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoice({ customer: null }));

      await handler(buildWebhookEvent('{}'));
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('skips when customer is deleted', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoice());
      setupDeletedCustomerRetrieve();

      await handler(buildWebhookEvent('{}'));
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('skips when customer has no userId', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoice());
      mockCustomersRetrieve.mockResolvedValue({
        id: MOCK_CUSTOMER_ID,
        deleted: false,
        metadata: {},
      });

      await handler(buildWebhookEvent('{}'));
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('handles invoice with Customer object instead of string', async () => {
      setupStripeEvent(
        'invoice.payment_failed',
        mockInvoice({
          customer: { id: MOCK_CUSTOMER_ID, deleted: false },
        }),
      );
      setupCustomerRetrieve();

      const result = await handler(buildWebhookEvent('{}'));

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
    });
  });

  // -----------------------------------------------------------------------
  // 9. Error handling & edge cases
  // -----------------------------------------------------------------------
  describe('error handling & edge cases', () => {
    it('returns 500 when UpdateItemCommand fails during processing', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());
      ddbMock.on(UpdateItemCommand).rejects(new Error('DynamoDB update failed'));

      const result = await handler(buildWebhookEvent('{}'));
      expect(result).toEqual({
        statusCode: 500,
        body: JSON.stringify({ message: 'Processing error' }),
      });
    });

    it('returns 500 when stripe.customers.retrieve fails', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      mockCustomersRetrieve.mockRejectedValue(new Error('Stripe API error'));

      const result = await handler(buildWebhookEvent('{}'));
      expect(result).toEqual({
        statusCode: 500,
        body: JSON.stringify({ message: 'Processing error' }),
      });
    });

    it('unhandled event type returns 200 and records idempotency', async () => {
      setupStripeEvent('some.unknown.event', {});

      const result = await handler(buildWebhookEvent('{}'));
      expect(result).toEqual({ statusCode: 200, body: JSON.stringify({ received: true }) });
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
    });

    it('returns 500 when idempotency PutItem fails (non-condition error)', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());
      ddbMock.on(PutItemCommand).rejects(new Error('DynamoDB put failed'));

      const result = await handler(buildWebhookEvent('{}'));
      expect(result).toEqual({
        statusCode: 500,
        body: JSON.stringify({ message: 'Idempotency check error' }),
      });
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 10. DunningEscalation metric (EMF via reportMetric)
  // -----------------------------------------------------------------------
  describe('DunningEscalation metric', () => {
    it('emits stage=entered on first payment_failed (attempt_count=1)', async () => {
      setupStripeEvent(
        'invoice.payment_failed',
        mockInvoice({
          attempt_count: 1,
          last_finalization_error: { code: 'card_declined' },
        }),
      );
      setupCustomerRetrieve();

      await handler(buildWebhookEvent('{}'));

      const emissions = dunningEmissions();
      expect(emissions).toHaveLength(1);
      expect(emissions[0]).toMatchObject({
        stage: 'entered',
        reason: 'card_declined',
        attemptBucket: '1',
        DunningEscalation: 1,
      });
      expect(emissions[0]._aws).toMatchObject({
        CloudWatchMetrics: [
          {
            Namespace: 'FilOne',
            Dimensions: [['stage', 'reason', 'attemptBucket']],
            Metrics: [{ Name: 'DunningEscalation', Unit: 'Count' }],
          },
        ],
      });
    });

    it('emits stage=retry on subsequent payment_failed (attempt_count>=2)', async () => {
      setupStripeEvent(
        'invoice.payment_failed',
        mockInvoice({
          attempt_count: 2,
          last_finalization_error: { code: 'insufficient_funds' },
        }),
      );
      setupCustomerRetrieve();

      await handler(buildWebhookEvent('{}'));

      expect(dunningEmissions()[0]).toMatchObject({
        stage: 'retry',
        reason: 'insufficient_funds',
        attemptBucket: '2',
      });
    });

    it('buckets attempt_count>=4 into "4+"', async () => {
      setupStripeEvent(
        'invoice.payment_failed',
        mockInvoice({
          attempt_count: 5,
          last_finalization_error: { code: 'card_declined' },
        }),
      );
      setupCustomerRetrieve();

      await handler(buildWebhookEvent('{}'));

      expect(dunningEmissions()[0]).toMatchObject({
        stage: 'retry',
        attemptBucket: '4+',
      });
    });

    it('reports reason="unknown" when last_finalization_error missing', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoice({ attempt_count: 1 }));
      setupCustomerRetrieve();

      await handler(buildWebhookEvent('{}'));

      expect(dunningEmissions()[0]).toMatchObject({
        stage: 'entered',
        reason: 'unknown',
      });
    });

    it('emits stage=canceled with cancellation_details.reason=payment_failed', async () => {
      setupStripeEvent(
        'customer.subscription.deleted',
        mockSubscription({
          cancellation_details: { reason: 'payment_failed' },
          latest_invoice: { id: 'in_latest', attempt_count: 3 },
        }),
      );
      setupCustomerRetrieve();

      await handler(buildWebhookEvent('{}'));

      expect(dunningEmissions()[0]).toMatchObject({
        stage: 'canceled',
        reason: 'payment_failed',
        attemptBucket: '3',
      });
    });

    it('labels canceled by cancellation_requested when voluntary', async () => {
      setupStripeEvent(
        'customer.subscription.deleted',
        mockSubscription({
          cancellation_details: { reason: 'cancellation_requested' },
        }),
      );
      setupCustomerRetrieve();

      await handler(buildWebhookEvent('{}'));

      expect(dunningEmissions()[0]).toMatchObject({
        stage: 'canceled',
        reason: 'cancellation_requested',
        attemptBucket: 'unknown',
      });
      // Grace-period behavior must still run regardless of reason
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
    });

    it('labels canceled as reason="unknown" when cancellation_details absent', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      setupCustomerRetrieve();

      await handler(buildWebhookEvent('{}'));

      expect(dunningEmissions()[0]).toMatchObject({
        stage: 'canceled',
        reason: 'unknown',
      });
    });

    it('emits stage=recovered when prior status was past_due', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice({ attempt_count: 2 }));
      setupCustomerRetrieve();
      ddbMock.on(UpdateItemCommand).resolves({
        Attributes: marshall({ subscriptionStatus: SubscriptionStatus.PastDue }),
      });

      await handler(buildWebhookEvent('{}'));

      expect(dunningEmissions()[0]).toMatchObject({
        stage: 'recovered',
        reason: 'past_due',
        attemptBucket: '2',
      });
    });

    it('emits stage=recovered with reason=grace_period when prior status was grace_period', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice({ attempt_count: 4 }));
      setupCustomerRetrieve();
      setupAuroraTenantResolution();
      ddbMock.on(UpdateItemCommand, { TableName: TABLE_NAME }).resolves({
        Attributes: marshall({ subscriptionStatus: SubscriptionStatus.GracePeriod }),
      });

      await handler(buildWebhookEvent('{}'));

      expect(dunningEmissions()[0]).toMatchObject({
        stage: 'recovered',
        reason: 'grace_period',
        attemptBucket: '4+',
      });
      // Aurora re-activation must still run
      expect(mockUpdateTenantStatus).toHaveBeenCalledWith({
        tenantId: MOCK_AURORA_TENANT_ID,
        status: 'ACTIVE',
      });
    });

    it('does NOT emit recovered on normal renewal (prior status was active)', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice({ attempt_count: 1 }));
      setupCustomerRetrieve();
      ddbMock.on(UpdateItemCommand).resolves({
        Attributes: marshall({ subscriptionStatus: SubscriptionStatus.Active }),
      });

      await handler(buildWebhookEvent('{}'));

      expect(dunningEmissions()).toHaveLength(0);
    });

    it('does NOT emit on unrelated events (customer.subscription.created)', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());

      await handler(buildWebhookEvent('{}'));

      expect(dunningEmissions()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 11. InvoicePaid metric (EMF via reportMetric)
  // -----------------------------------------------------------------------
  describe('InvoicePaid metric', () => {
    function invoicePaidEmissions(): MetricEvent[] {
      return reportMetricMock.mock.calls
        .map(([event]) => event)
        .filter((e) => (e as { InvoicePaid?: unknown }).InvoicePaid === 1);
    }

    it('emits one InvoicePaid event on invoice.payment_succeeded', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      setupCustomerRetrieve();

      await handler(buildWebhookEvent('{}'));

      const emissions = invoicePaidEmissions();
      expect(emissions).toHaveLength(1);
      expect(emissions[0]).toMatchObject({ InvoicePaid: 1 });
      expect(emissions[0]._aws).toMatchObject({
        CloudWatchMetrics: [
          {
            Namespace: 'FilOne',
            Dimensions: [[]],
            Metrics: [{ Name: 'InvoicePaid', Unit: 'Count' }],
          },
        ],
      });
    });

    it('does not emit even when invoice.customer is null', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice({ customer: null }));

      await handler(buildWebhookEvent('{}'));

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(invoicePaidEmissions()).toHaveLength(0);
    });

    it('does NOT emit on invoice.payment_failed', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoice({ attempt_count: 1 }));
      setupCustomerRetrieve();

      await handler(buildWebhookEvent('{}'));

      expect(invoicePaidEmissions()).toHaveLength(0);
    });

    it('does NOT emit on unrelated events (customer.subscription.created)', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());

      await handler(buildWebhookEvent('{}'));

      expect(invoicePaidEmissions()).toHaveLength(0);
    });
  });
});
