import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { SQSEvent } from 'aws-lambda';
import { type MetricEvent, reportMetric } from '../lib/metrics.ts';
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

// The orchestrator registry instantiates real clients at import time; mock it
// so the otherwise-real region-helpers module can be loaded below.
vi.mock('../lib/service-orchestrator-registry.ts', () => ({
  getAvailableOrchestrators: () => [],
}));

const mockSyncTenantStatusInProvisionedRegions = vi.fn();
vi.mock('../lib/region-helpers.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/region-helpers.ts')>()),
  syncTenantStatusInProvisionedRegions: (...args: unknown[]) =>
    mockSyncTenantStatusInProvisionedRegions(...args),
}));

const mockCustomersRetrieve = vi.fn();
const mockPaymentMethodsRetrieve = vi.fn();

vi.mock('../lib/stripe-client.ts', () => ({
  getStripeClient: () => ({
    customers: { retrieve: mockCustomersRetrieve },
    paymentMethods: { retrieve: mockPaymentMethodsRetrieve },
  }),
}));

const mockStartDeletion = vi.fn(async (_params: unknown) => undefined);
vi.mock('../lib/deletion-from-stripe.ts', () => ({
  startDeletionFromStripe: (params: unknown) => mockStartDeletion(params),
}));

vi.mock('../lib/metrics.ts', () => ({
  reportMetric: vi.fn(),
}));

const reportMetricMock = vi.mocked(reportMetric);

const ddbMock = mockClient(DynamoDBClient);

import { handler } from './stripe-event-worker.ts';
import { BILLING_IDENTITY_PROJECTION, MissingOrgIdError } from '../lib/subscription-store.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TABLE_NAME = 'BillingTable';
const MOCK_USER_ID = 'test-user-uuid';
const MOCK_CUSTOMER_ID = 'cus_test_123';
const MOCK_SUBSCRIPTION_ID = 'sub_test_456';
const MOCK_EVENT_ID = 'evt_test_789';
const MOCK_ORG_ID = 'test-org-uuid';

let currentEvent: unknown = {};

/** Deliver the event set up by setupStripeEvent to the worker as one SQS record. */
function deliver() {
  return handler({ Records: [{ body: JSON.stringify(currentEvent) }] } as unknown as SQSEvent);
}

function mockSubscription(overrides?: Record<string, unknown>) {
  return {
    id: MOCK_SUBSCRIPTION_ID,
    customer: MOCK_CUSTOMER_ID,
    status: 'active',
    metadata: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID },
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

/**
 * An invoice carrying the subscription metadata Stripe snapshots onto it at
 * finalization, which is where an invoice event learns its org.
 */
function mockInvoiceForOrgSubscription(overrides?: Record<string, unknown>) {
  return mockInvoice({
    parent: {
      subscription_details: {
        subscription: MOCK_SUBSCRIPTION_ID,
        metadata: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID },
      },
    },
    ...overrides,
  });
}

function setupStripeEvent(type: string, object: unknown) {
  currentEvent = { id: MOCK_EVENT_ID, type, data: { object } };
}

function setupCustomerRetrieve(userId?: string, orgId?: string) {
  mockCustomersRetrieve.mockResolvedValue({
    id: MOCK_CUSTOMER_ID,
    deleted: false,
    metadata: { userId: userId ?? MOCK_USER_ID, orgId: orgId ?? MOCK_ORG_ID },
  });
}

/** A customer whose metadata names no org, so no billing row can be addressed for it. */
function setupCustomerRetrieveWithoutOrg() {
  mockCustomersRetrieve.mockResolvedValue({
    id: MOCK_CUSTOMER_ID,
    deleted: false,
    metadata: { userId: MOCK_USER_ID },
  });
}

/**
 * What the stored billing row names, for the guards that compare it against the
 * event in hand. Keyed on the projection so it does not answer the org-resolution
 * read, which projects `orgId`.
 */
function setupStoredIdentity(identity: { subscriptionId?: string; stripeCustomerId?: string }) {
  ddbMock
    .on(GetItemCommand, { ProjectionExpression: BILLING_IDENTITY_PROJECTION })
    .resolves({ Item: marshall(identity) });
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
    metadata: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID },
    invoice_settings: {
      default_payment_method: mockPaymentMethod(),
    },
    ...overrides,
  };
}

function setupPaymentMethodsRetrieve() {
  mockPaymentMethodsRetrieve.mockResolvedValue(mockPaymentMethod());
}

const MOCK_AURORA_TENANT_ID = 'aurora-tenant-123';

// The key every subscription write lands on. The org id in it comes from Stripe
// metadata, which is the only place the webhook can learn it.
const ORG_KEY = { pk: { S: `ORG#${MOCK_ORG_ID}` }, sk: { S: 'SUBSCRIPTION' } };

// The pre-re-key row, which is where a customer created before
// `metadata.orgId` existed still names its org.
const LEGACY_KEY = { pk: { S: `CUSTOMER#${MOCK_USER_ID}` }, sk: { S: 'SUBSCRIPTION' } };

function updateInputs() {
  return ddbMock.commandCalls(UpdateItemCommand).map((c) => c.args[0].input);
}

function updatedKeys() {
  return updateInputs().map((input) => input.Key);
}

// Per-region failure as reported by syncTenantStatusInProvisionedRegions,
// which never throws.
function regionSyncFailure(cause: Error) {
  return [
    {
      orchestratorId: 'aurora',
      tenantId: MOCK_AURORA_TENANT_ID,
      outcome: 'error' as const,
      cause,
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stripe-event-worker handler', () => {
  function dunningEmissions(): MetricEvent[] {
    return reportMetricMock.mock.calls
      .map(([event]) => event)
      .filter((e) => (e as { DunningEscalation?: unknown }).DunningEscalation === 1);
  }

  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    currentEvent = {};
    mockCustomersRetrieve.mockReset();
    mockPaymentMethodsRetrieve.mockReset();
    mockSyncTenantStatusInProvisionedRegions.mockReset();
    mockSyncTenantStatusInProvisionedRegions.mockResolvedValue([]);
    mockStartDeletion.mockReset();
    reportMetricMock.mockReset();
  });

  // -----------------------------------------------------------------------
  // Idempotency: an event is marked processed once its handling succeeds
  // -----------------------------------------------------------------------
  describe('idempotency', () => {
    const MARK_KEY = { pk: { S: `WEBHOOK#${MOCK_EVENT_ID}` }, sk: { S: 'EVENT' } };

    it('skips an event already marked processed', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());
      ddbMock
        .on(GetItemCommand, { Key: MARK_KEY })
        .resolves({ Item: { ...MARK_KEY, eventType: { S: 'customer.subscription.created' } } });

      await deliver();

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    });

    it('reads the mark with a strongly consistent read', async () => {
      setupStripeEvent('unknown.event', {});

      await deliver();

      expect(ddbMock.commandCalls(GetItemCommand)[0].args[0].input).toStrictEqual({
        TableName: TABLE_NAME,
        Key: MARK_KEY,
        ConsistentRead: true,
      });
    });

    it('writes the processed mark only after the billing update', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());

      await deliver();

      const writes = ddbMock
        .calls()
        .map((c) => c.args[0])
        .filter((cmd) => cmd instanceof UpdateItemCommand || cmd instanceof PutItemCommand);
      expect(writes.map((cmd) => cmd.constructor)).toEqual([UpdateItemCommand, PutItemCommand]);
    });

    it('marks the event with its type and a 30-day TTL', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());

      const before = Math.floor(Date.now() / 1000);
      await deliver();
      const after = Math.floor(Date.now() / 1000);

      const input = ddbMock.commandCalls(PutItemCommand)[0].args[0].input;
      expect(input).toStrictEqual({
        TableName: TABLE_NAME,
        Item: {
          ...MARK_KEY,
          eventType: { S: 'customer.subscription.created' },
          processedAt: { S: expect.any(String) },
          ttl: { N: expect.any(String) },
        },
      });

      const ttl = Number(input.Item!.ttl.N);
      const thirtyDays = 30 * 24 * 60 * 60;
      expect(ttl).toBeGreaterThanOrEqual(before + thirtyDays);
      expect(ttl).toBeLessThanOrEqual(after + thirtyDays + 1);
    });

    it('leaves the event unmarked and fails the delivery when processing fails', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());
      ddbMock.on(UpdateItemCommand).rejects(new Error('DynamoDB error'));

      await expect(deliver()).rejects.toThrow('DynamoDB error');

      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    });

    it('fails the delivery when the mark cannot be read', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());
      ddbMock.on(GetItemCommand, { Key: MARK_KEY }).rejects(new Error('DynamoDB get failed'));

      await expect(deliver()).rejects.toThrow('DynamoDB get failed');

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // customer.subscription.created
  // -----------------------------------------------------------------------
  describe('customer.subscription.created', () => {
    it('updates the billing record named by subscription.metadata', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());

      await deliver();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toStrictEqual({
        TableName: TABLE_NAME,
        Key: ORG_KEY,
        UpdateExpression:
          'SET subscriptionId = :subId, subscriptionStatus = :status, currentPeriodEnd = :periodEnd, currentPeriodStart = :periodStart, updatedAt = :now, orgId = if_not_exists(orgId, :orgId) REMOVE gracePeriodEndsAt, canceledAt',
        ExpressionAttributeValues: {
          ':subId': { S: MOCK_SUBSCRIPTION_ID },
          ':status': { S: 'active' },
          ':periodStart': { S: new Date(1600000000 * 1000).toISOString() },
          ':periodEnd': { S: new Date(1700000000 * 1000).toISOString() },
          ':now': { S: expect.any(String) },
          ':orgId': { S: MOCK_ORG_ID },
        },
        ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(deletedAt))',
      });
    });

    it('falls back to customer metadata when subscription metadata empty', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription({ metadata: {} }));
      // A distinct org on the customer: the key the write lands on is what says
      // which metadata the handler read.
      setupCustomerRetrieve('fallback-user', 'fallback-org');

      await deliver();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          Key: {
            pk: { S: 'ORG#fallback-org' },
            sk: { S: 'SUBSCRIPTION' },
          },
        }),
      );
      expect(mockCustomersRetrieve).toHaveBeenCalledWith(MOCK_CUSTOMER_ID);
    });

    it('skips when customer is deleted (fallback path)', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription({ metadata: {} }));
      setupDeletedCustomerRetrieve();

      await deliver();
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('skips when neither metadata source has userId', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription({ metadata: {} }));
      mockCustomersRetrieve.mockResolvedValue({
        id: MOCK_CUSTOMER_ID,
        deleted: false,
        metadata: {},
      });

      await deliver();
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('handles string customer ID via getCustomerIdString', async () => {
      setupStripeEvent(
        'customer.subscription.created',
        mockSubscription({ customer: 'cus_string_id' }),
      );

      await deliver();
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

      await deliver();
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

      await deliver();
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('passes through non-active subscription status', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription({ status: 'past_due' }));

      await deliver();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':status': { S: 'past_due' },
          }),
        }),
      );
    });

    it('skips DDB update when Stripe status is incomplete (unmappable)', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setupStripeEvent('customer.subscription.created', mockSubscription({ status: 'incomplete' }));

      await deliver();

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalledWith(
        '[stripe-webhook] Unmappable Stripe status, skipping update',
        expect.objectContaining({ stripeStatus: 'incomplete' }),
      );
      consoleSpy.mockRestore();
    });

    it('maps incomplete_expired to canceled', async () => {
      setupStripeEvent(
        'customer.subscription.created',
        mockSubscription({ status: 'incomplete_expired' }),
      );

      await deliver();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':status': { S: SubscriptionStatus.Canceled },
          }),
        }),
      );
    });

    it('maps unpaid to past_due', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription({ status: 'unpaid' }));

      await deliver();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':status': { S: SubscriptionStatus.PastDue },
          }),
        }),
      );
    });

    it('falls back to customer lookup when userId is empty string', async () => {
      setupStripeEvent(
        'customer.subscription.created',
        mockSubscription({ metadata: { userId: '' } }),
      );
      setupCustomerRetrieve('fallback-user', 'fallback-org');

      await deliver();

      expect(mockCustomersRetrieve).toHaveBeenCalledWith(MOCK_CUSTOMER_ID);
      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          Key: {
            pk: { S: 'ORG#fallback-org' },
            sk: { S: 'SUBSCRIPTION' },
          },
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // customer.subscription.updated
  // -----------------------------------------------------------------------
  describe('customer.subscription.updated', () => {
    it('processes same as created (UpdateItemCommand with correct key/values)', async () => {
      setupStripeEvent('customer.subscription.updated', mockSubscription());

      await deliver();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toStrictEqual({
        TableName: TABLE_NAME,
        Key: ORG_KEY,
        UpdateExpression:
          'SET subscriptionId = :subId, subscriptionStatus = :status, currentPeriodEnd = :periodEnd, currentPeriodStart = :periodStart, updatedAt = :now, orgId = if_not_exists(orgId, :orgId) REMOVE gracePeriodEndsAt, canceledAt',
        ExpressionAttributeValues: {
          ':subId': { S: MOCK_SUBSCRIPTION_ID },
          ':status': { S: 'active' },
          ':periodStart': { S: new Date(1600000000 * 1000).toISOString() },
          ':periodEnd': { S: new Date(1700000000 * 1000).toISOString() },
          ':now': { S: expect.any(String) },
          ':orgId': { S: MOCK_ORG_ID },
        },
        ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(deletedAt))',
      });
    });

    it('sets currentPeriodEnd from subscription.items.data[0].current_period_end', async () => {
      setupStripeEvent(
        'customer.subscription.updated',
        mockSubscription({
          items: { data: [{ current_period_end: 1800000000 }] },
        }),
      );

      await deliver();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':periodEnd': { S: new Date(1800000000 * 1000).toISOString() },
          }),
        }),
      );
    });

    it('handles empty items.data array (defaults to epoch 0)', async () => {
      setupStripeEvent(
        'customer.subscription.updated',
        mockSubscription({
          items: { data: [] },
        }),
      );

      await deliver();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toEqual(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ':periodEnd': { S: new Date(0).toISOString() },
          }),
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // customer.updated
  // -----------------------------------------------------------------------
  describe('customer.updated', () => {
    let consoleSpy: MockInstance | undefined;

    afterEach(() => {
      consoleSpy?.mockRestore();
      consoleSpy = undefined;
    });

    it('updates payment method in DynamoDB when default_payment_method is expanded object', async () => {
      setupStripeEvent('customer.updated', mockCustomerObject());

      await deliver();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input).toStrictEqual({
        TableName: TABLE_NAME,
        Key: ORG_KEY,
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
        ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(deletedAt))',
      });
    });

    it('swallows a missing billing row, with a metric so it is not silent', async () => {
      // The event carries a card's last four and expiry. A throw would buy
      // retries and a DLQ entry to redeliver that; post-verify
      // the state is near-impossible and the metric is how anyone learns of it.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      setupStripeEvent('customer.updated', mockCustomerObject());
      const noRow = new Error('The conditional request failed');
      (noRow as { name: string }).name = 'ConditionalCheckFailedException';
      ddbMock.on(UpdateItemCommand).rejects(noRow);

      await deliver();

      expect(
        reportMetricMock.mock.calls.some(
          ([event]) => (event as { BillingRowMissing?: number }).BillingRowMissing === 1,
        ),
      ).toBe(true);
      errorSpy.mockRestore();
    });

    it('fetches payment method via paymentMethods.retrieve when default_payment_method is a string ID', async () => {
      setupStripeEvent(
        'customer.updated',
        mockCustomerObject({
          invoice_settings: { default_payment_method: MOCK_PM_ID },
        }),
      );
      setupPaymentMethodsRetrieve();

      await deliver();

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
    });

    it('resolves the org from the billing row when the customer metadata carries none', async () => {
      // Nothing stamped metadata.orgId onto customers created before it, and
      // the re-key made no Stripe calls — so without this fallback every
      // metadata write by the daily usage worker fails and ends up in the DLQ.
      setupStripeEvent(
        'customer.updated',
        mockCustomerObject({ metadata: { userId: MOCK_USER_ID } }),
      );
      ddbMock
        .on(GetItemCommand, { Key: LEGACY_KEY })
        .resolves({ Item: marshall({ orgId: MOCK_ORG_ID }) });

      await deliver();

      expect(updatedKeys()).toEqual([ORG_KEY]);
    });

    it('does not read the billing row when the metadata already names the org', async () => {
      setupStripeEvent('customer.updated', mockCustomerObject());

      await deliver();

      const legacyReads = ddbMock
        .commandCalls(GetItemCommand)
        .filter((call) => call.args[0].input.Key?.pk?.S === `CUSTOMER#${MOCK_USER_ID}`);
      expect(legacyReads).toHaveLength(0);
    });

    it('acknowledges a customer no source can resolve to an org', async () => {
      // The rows carrying no orgId were dispositioned by name before the
      // re-key, so no retry converges on an answer: retrying would spend every
      // delivery and park the event in the DLQ.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      setupStripeEvent(
        'customer.updated',
        mockCustomerObject({ metadata: { userId: MOCK_USER_ID } }),
      );

      await deliver();

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('resolves to no org'),
        expect.objectContaining({ customerId: MOCK_CUSTOMER_ID, userId: MOCK_USER_ID }),
      );
      errorSpy.mockRestore();
    });

    it('throws when customer has no userId in metadata', async () => {
      setupStripeEvent('customer.updated', mockCustomerObject({ metadata: {} }));

      await expect(deliver()).rejects.toThrow('No userId in metadata');
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    });

    it('skips update when default_payment_method is null', async () => {
      setupStripeEvent(
        'customer.updated',
        mockCustomerObject({
          invoice_settings: { default_payment_method: null },
        }),
      );

      await deliver();

      // This handler path should not perform any DynamoDB updates or deletes.
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('skips update for trial-creation customer.updated event (currency null → usd, no default_payment_method)', async () => {
      const TRIAL_USER_ID = '2bfd6596-4ccb-47a8-b508-bf64fdb44d4e';
      const TRIAL_ORG_ID = '7d352bd8-ed9e-4f2a-8ec3-6ba7ae356525';
      const TRIAL_CUSTOMER_ID = 'cus_UN4LxyuGMbKzKz';
      const TRIAL_EVENT_ID = 'evt_1TOKCkAQEKri8lBk4HwPEKWK';

      consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      currentEvent = {
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
      };

      await deliver();

      // This handler path should not perform any DynamoDB updates or deletes.
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('customer.updated without default_payment_method'),
        expect.objectContaining({ customerId: TRIAL_CUSTOMER_ID, userId: TRIAL_USER_ID }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // customer.subscription.deleted
  // -----------------------------------------------------------------------
  describe('a subscription the account has already replaced', () => {
    function supersededEmissions(): MetricEvent[] {
      return reportMetricMock.mock.calls
        .map(([event]) => event)
        .filter((e) => (e as { SupersededBillingEvent?: unknown }).SupersededBillingEvent === 1);
    }

    it('does not put a paying tenant into grace on a late cancellation', async () => {
      // Stripe retries out of order: a cancellation for the trial subscription
      // an upgrade replaced can arrive after the replacement is live.
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      setupCustomerRetrieve();
      setupStoredIdentity({ subscriptionId: 'sub_the_live_one' });

      await deliver();

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(mockSyncTenantStatusInProvisionedRegions).not.toHaveBeenCalled();
      expect(supersededEmissions()).toHaveLength(1);
    });

    it('grants the grace period when the event names the subscription on the row', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      setupCustomerRetrieve();
      setupStoredIdentity({ subscriptionId: MOCK_SUBSCRIPTION_ID });

      await deliver();

      expect(updateInputs()[0].ExpressionAttributeValues![':status']).toEqual({
        S: SubscriptionStatus.GracePeriod,
      });
      expect(supersededEmissions()).toHaveLength(0);
    });

    it('does not mark a live subscription past due on a late payment failure', async () => {
      setupStripeEvent(
        'invoice.payment_failed',
        mockInvoice({
          parent: { subscription_details: { subscription: 'sub_the_old_one' } },
        }),
      );
      setupCustomerRetrieve();
      setupStoredIdentity({ subscriptionId: MOCK_SUBSCRIPTION_ID });

      await deliver();

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(supersededEmissions()).toHaveLength(1);
    });

    it('does not reactivate the org on a successful invoice from a replaced subscription', async () => {
      // The other direction of the same refusal: on the shared org row, a late
      // success for historical subscription A would mark the org active and
      // re-enable tenants the authoritative past-due subscription locked.
      setupStripeEvent(
        'invoice.payment_succeeded',
        mockInvoice({
          parent: { subscription_details: { subscription: 'sub_the_old_one' } },
        }),
      );
      setupCustomerRetrieve();
      setupStoredIdentity({ subscriptionId: MOCK_SUBSCRIPTION_ID });

      await deliver();

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(mockSyncTenantStatusInProvisionedRegions).not.toHaveBeenCalled();
      expect(supersededEmissions()).toHaveLength(1);
    });

    it('marks past due when the failing invoice names the subscription on the row', async () => {
      setupStripeEvent(
        'invoice.payment_failed',
        mockInvoice({
          parent: { subscription_details: { subscription: MOCK_SUBSCRIPTION_ID } },
        }),
      );
      setupCustomerRetrieve();
      setupStoredIdentity({ subscriptionId: MOCK_SUBSCRIPTION_ID });

      await deliver();

      expect(updateInputs()[0].ExpressionAttributeValues![':status']).toEqual({
        S: SubscriptionStatus.PastDue,
      });
      expect(supersededEmissions()).toHaveLength(0);
    });

    it('still applies an update arriving under a new subscription id', async () => {
      // The upsert keeps last-writer-wins: an upgrade legitimately arrives
      // under an id the row has never seen, and refusing it as superseded would
      // leave the account on the plan it just left.
      setupStripeEvent('customer.subscription.updated', mockSubscription());
      setupCustomerRetrieve();
      setupStoredIdentity({ subscriptionId: 'sub_the_previous_one' });

      await deliver();

      expect(updateInputs()[0].ExpressionAttributeValues![':subId']).toEqual({
        S: MOCK_SUBSCRIPTION_ID,
      });
      expect(supersededEmissions()).toHaveLength(0);
    });
  });

  describe('customer.subscription.deleted', () => {
    it('sets GracePeriod status with 30-day grace window', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      setupCustomerRetrieve();

      const before = Date.now();
      await deliver();
      const after = Date.now();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      expect(input).toStrictEqual({
        TableName: TABLE_NAME,
        Key: ORG_KEY,
        UpdateExpression:
          'SET subscriptionStatus = :status, canceledAt = :canceledAt, gracePeriodEndsAt = :grace, updatedAt = :now, orgId = if_not_exists(orgId, :orgId)',
        ExpressionAttributeValues: {
          ':status': { S: SubscriptionStatus.GracePeriod },
          ':canceledAt': { S: expect.any(String) },
          ':now': { S: expect.any(String) },
          ':grace': { S: expect.any(String) },
          ':orgId': { S: MOCK_ORG_ID },
        },
        ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(deletedAt))',
      });

      const graceDate = new Date(input.ExpressionAttributeValues![':grace'].S!).getTime();
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      expect(graceDate).toBeGreaterThanOrEqual(before + thirtyDays - 5000);
      expect(graceDate).toBeLessThanOrEqual(after + thirtyDays + 5000);
      expect(mockCustomersRetrieve).toHaveBeenCalledWith(MOCK_CUSTOMER_ID);
    });

    it('dates the cancellation and grace deadline from when Stripe ended the subscription', async () => {
      // A redelivered event then writes the same deadline instead of pushing it
      // out by the time the event spent in the queue.
      const endedAt = Date.UTC(2026, 9, 1) / 1000;
      setupStripeEvent('customer.subscription.deleted', mockSubscription({ ended_at: endedAt }));
      setupCustomerRetrieve();

      await deliver();

      const values =
        ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input.ExpressionAttributeValues!;
      expect(values).toMatchObject({
        ':canceledAt': { S: '2026-10-01T00:00:00.000Z' },
        ':grace': { S: '2026-10-31T00:00:00.000Z' },
      });
    });

    it('sets GracePeriod status with 7-day grace window for trialing subscriptions', async () => {
      const futureTrialEnd = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
      setupStripeEvent(
        'customer.subscription.deleted',
        mockSubscription({ trial_end: futureTrialEnd }),
      );
      setupCustomerRetrieve();

      const before = Date.now();
      await deliver();
      const after = Date.now();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      const graceDate = new Date(input.ExpressionAttributeValues![':grace'].S!).getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      expect(graceDate).toBeGreaterThanOrEqual(before + sevenDays - 5000);
      expect(graceDate).toBeLessThanOrEqual(after + sevenDays + 5000);
    });

    it('falls back to the subscription’s own org when the customer names none', async () => {
      // The subscription's metadata is the more specific answer, and resolving
      // only from the customer defined a cohort of accounts whose cancellation
      // quietly wrote nothing.
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      setupCustomerRetrieveWithoutOrg();

      await deliver();

      expect(updatedKeys()).toEqual([ORG_KEY]);
    });

    it('fails the delivery when neither object names an org', async () => {
      // The org id is both the row's address and the tenant's name, so nothing
      // can be written or locked. The event stays unmarked, so it is retried and
      // then parked in the DLQ, where it can be redriven once the metadata is
      // repaired.
      setupStripeEvent(
        'customer.subscription.deleted',
        mockSubscription({ metadata: { userId: MOCK_USER_ID } }),
      );
      setupCustomerRetrieveWithoutOrg();

      await expect(deliver()).rejects.toThrow(MissingOrgIdError);

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(mockSyncTenantStatusInProvisionedRegions).not.toHaveBeenCalled();
    });

    describe('when the customer is already deleted', () => {
      // The fallback for a customer.deleted event that was never delivered.
      it('starts the deletion instead of granting a grace period', async () => {
        setupStripeEvent('customer.subscription.deleted', mockSubscription());
        setupDeletedCustomerRetrieve();

        await deliver();

        expect(mockStartDeletion).toHaveBeenCalledWith(
          expect.objectContaining({ userId: MOCK_USER_ID, caller: 'subscription.deleted' }),
        );
        expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      });

      it('emits a DunningEscalation metric with reason customer_deleted', async () => {
        setupStripeEvent('customer.subscription.deleted', mockSubscription());
        setupDeletedCustomerRetrieve();

        await deliver();

        const emissions = dunningEmissions();
        expect(
          emissions.some(
            (e) =>
              (e as { stage?: string }).stage === 'canceled' &&
              (e as { reason?: string }).reason === 'customer_deleted',
          ),
        ).toBe(true);
      });

      // Nothing can be resolved without it, and retrying an event that will
      // never succeed only parks it in the DLQ.
      it('acknowledges when the subscription has no metadata.userId', async () => {
        setupStripeEvent('customer.subscription.deleted', mockSubscription({ metadata: {} }));
        setupDeletedCustomerRetrieve();
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
          await deliver();

          expect(mockStartDeletion).not.toHaveBeenCalled();
          expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
        } finally {
          error.mockRestore();
        }
      });
    });

    it('skips when customer has no userId', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      mockCustomersRetrieve.mockResolvedValue({
        id: MOCK_CUSTOMER_ID,
        deleted: false,
        metadata: {},
      });

      await deliver();
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('calls updateTenantStatus WRITE_LOCKED on subscription deletion', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      setupCustomerRetrieve();

      await deliver();

      expect(mockSyncTenantStatusInProvisionedRegions).toHaveBeenCalledWith(
        MOCK_ORG_ID,
        'write-locked',
      );
    });

    it('fails the delivery when Aurora WRITE_LOCK fails, so SQS retries it', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      setupCustomerRetrieve();
      mockSyncTenantStatusInProvisionedRegions.mockResolvedValue(
        regionSyncFailure(new Error('Aurora API error')),
      );

      await expect(deliver()).rejects.toThrow('tenant status sync failed for: aurora');

      // The grace period is already recorded when the lock is attempted
      expect(updatedKeys()).toEqual([ORG_KEY]);
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // customer.deleted
  // -----------------------------------------------------------------------
  describe('customer.deleted', () => {
    // Deleting the customer in Stripe is the standing response to trial abuse, so
    // terminating the account is its intended meaning.
    it('starts the full account deletion', async () => {
      setupStripeEvent(
        'customer.deleted',
        mockCustomerObject({ metadata: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID } }),
      );

      await deliver();

      expect(mockStartDeletion).toHaveBeenCalledWith({
        userId: MOCK_USER_ID,
        customerId: MOCK_CUSTOMER_ID,
        orgId: MOCK_ORG_ID,
        caller: 'customer.deleted',
      });
      // The teardown owns every write from here; the handler makes none.
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('reads userId from the event payload and never calls Stripe customers.retrieve', async () => {
      setupStripeEvent('customer.deleted', mockCustomerObject());

      await deliver();

      expect(mockCustomersRetrieve).not.toHaveBeenCalled();
    });

    // The deletion record and the sweeper own retries, so the worker always
    // acknowledges this event.
    it('acknowledges when customer.deleted has no userId in metadata', async () => {
      setupStripeEvent('customer.deleted', mockCustomerObject({ metadata: {} }));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await deliver();

        expect(mockStartDeletion).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
      }
    });

    it('emits a DunningEscalation metric with reason customer_deleted', async () => {
      setupStripeEvent('customer.deleted', mockCustomerObject());

      await deliver();

      const emissions = dunningEmissions();
      expect(
        emissions.some(
          (e) =>
            (e as { stage?: string }).stage === 'canceled' &&
            (e as { reason?: string }).reason === 'customer_deleted',
        ),
      ).toBe(true);
    });

    // metadata.orgId is written at customer creation; the entry point falls back to
    // the billing row for customers that predate it.
    it('passes no orgId through when the customer metadata carries none', async () => {
      setupStripeEvent(
        'customer.deleted',
        mockCustomerObject({ metadata: { userId: MOCK_USER_ID } }),
      );

      await deliver();

      expect(mockStartDeletion).toHaveBeenCalledWith(
        expect.objectContaining({ userId: MOCK_USER_ID, orgId: undefined }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // customer.subscription.trial_will_end
  // -----------------------------------------------------------------------
  describe('customer.subscription.trial_will_end', () => {
    it('writes no billing update for trial_will_end and marks the event processed', async () => {
      setupStripeEvent('customer.subscription.trial_will_end', mockSubscription());

      await deliver();
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // invoice.payment_succeeded
  // -----------------------------------------------------------------------
  describe('invoice.payment_succeeded', () => {
    it('sets Active status, REMOVEs gracePeriodEndsAt, lastPaymentFailedAt, and canceledAt', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      setupCustomerRetrieve();

      await deliver();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);

      expect(updateCalls[0].args[0].input).toStrictEqual({
        TableName: TABLE_NAME,
        Key: ORG_KEY,
        UpdateExpression:
          'SET subscriptionStatus = :active, lastPaymentAt = :now, updatedAt = :now, orgId = if_not_exists(orgId, :orgId) REMOVE gracePeriodEndsAt, lastPaymentFailedAt, canceledAt',
        ExpressionAttributeValues: {
          ':active': { S: SubscriptionStatus.Active },
          ':now': { S: expect.any(String) },
          ':orgId': { S: MOCK_ORG_ID },
        },
        ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(deletedAt))',
        ReturnValues: 'ALL_OLD',
      });
      expect(mockCustomersRetrieve).toHaveBeenCalledWith(MOCK_CUSTOMER_ID);
    });

    it('skips when invoice.customer is null', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice({ customer: null }));

      await deliver();
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('skips when customer is deleted', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      setupDeletedCustomerRetrieve();

      await deliver();
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('skips when customer has no userId', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      mockCustomersRetrieve.mockResolvedValue({
        id: MOCK_CUSTOMER_ID,
        deleted: false,
        metadata: {},
      });

      await deliver();
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

      await deliver();

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
    });

    it('calls updateTenantStatus ACTIVE on payment success', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      setupCustomerRetrieve();

      await deliver();

      expect(mockSyncTenantStatusInProvisionedRegions).toHaveBeenCalledWith(MOCK_ORG_ID, 'active');
    });

    it('fails the delivery when Aurora re-activation fails, so SQS retries it', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      setupCustomerRetrieve();
      mockSyncTenantStatusInProvisionedRegions.mockResolvedValue(
        regionSyncFailure(new Error('Aurora API error')),
      );

      await expect(deliver()).rejects.toThrow('tenant status sync failed for: aurora');

      expect(updatedKeys()).toEqual([ORG_KEY]);
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // invoice.payment_failed
  // -----------------------------------------------------------------------
  describe('invoice.payment_failed', () => {
    it('fails the delivery when the Stripe objects name no org', async () => {
      // There is no key to write the row under, and no billing-row fallback any
      // more. Failing the delivery leaves the event unmarked, so it is retried and
      // then parked in the DLQ, where it can be redriven once the metadata is
      // repaired; reporting success would consume the event and take the status
      // change with it.
      setupStripeEvent('invoice.payment_failed', mockInvoice());
      setupCustomerRetrieveWithoutOrg();

      await expect(deliver()).rejects.toThrow(MissingOrgIdError);

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    });

    it('sets PastDue status with lastPaymentFailedAt (no grace period)', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoice());
      setupCustomerRetrieve();

      await deliver();

      const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      expect(input).toStrictEqual({
        TableName: TABLE_NAME,
        Key: ORG_KEY,
        UpdateExpression:
          'SET subscriptionStatus = :status, lastPaymentFailedAt = :failedAt, updatedAt = :now, orgId = if_not_exists(orgId, :orgId)',
        ExpressionAttributeValues: {
          ':status': { S: SubscriptionStatus.PastDue },
          ':failedAt': { S: expect.any(String) },
          ':now': { S: expect.any(String) },
          ':orgId': { S: MOCK_ORG_ID },
        },
        ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(deletedAt))',
      });

      // Must NOT set gracePeriodEndsAt — Stripe Smart Retries handle the retry window
      expect(input.UpdateExpression).not.toContain('gracePeriodEndsAt');
      expect(mockCustomersRetrieve).toHaveBeenCalledWith(MOCK_CUSTOMER_ID);
    });

    it('skips when invoice.customer is null', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoice({ customer: null }));

      await deliver();
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('skips when customer is deleted', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoice());
      setupDeletedCustomerRetrieve();

      await deliver();
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    });

    it('skips when customer has no userId', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoice());
      mockCustomersRetrieve.mockResolvedValue({
        id: MOCK_CUSTOMER_ID,
        deleted: false,
        metadata: {},
      });

      await deliver();
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

      await deliver();

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Error handling & edge cases
  // -----------------------------------------------------------------------
  describe('error handling & edge cases', () => {
    it('fails the delivery when UpdateItemCommand fails during processing', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());
      ddbMock.on(UpdateItemCommand).rejects(new Error('DynamoDB update failed'));

      await expect(deliver()).rejects.toThrow('DynamoDB update failed');
    });

    it('fails the delivery when stripe.customers.retrieve fails', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      mockCustomersRetrieve.mockRejectedValue(new Error('Stripe API error'));

      await expect(deliver()).rejects.toThrow('Stripe API error');
    });

    it('unhandled event type is marked processed', async () => {
      setupStripeEvent('some.unknown.event', {});

      await deliver();
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
    });

    it('acknowledges the delivery, with an error log, when the processed mark cannot be written', async () => {
      // The event was handled. Failing the delivery would make SQS handle it
      // again and count its metrics twice; an unmarked event only matters if
      // Stripe redelivers it after the queue's 5-minute dedup window.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      setupStripeEvent('customer.subscription.created', mockSubscription());
      ddbMock.on(PutItemCommand).rejects(new Error('DynamoDB put failed'));

      await expect(deliver()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        '[stripe-webhook] Failed to mark event processed:',
        MOCK_EVENT_ID,
        expect.objectContaining({ message: 'DynamoDB put failed' }),
      );
      errorSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // DunningEscalation metric (EMF via reportMetric)
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

      await deliver();

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

      await deliver();

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

      await deliver();

      expect(dunningEmissions()[0]).toMatchObject({
        stage: 'retry',
        attemptBucket: '4+',
      });
    });

    it('reports reason="unknown" when last_finalization_error missing', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoice({ attempt_count: 1 }));
      setupCustomerRetrieve();

      await deliver();

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

      await deliver();

      expect(dunningEmissions()[0]).toMatchObject({
        stage: 'canceled',
        reason: 'payment_failed',
        attemptBucket: '3',
      });
    });

    it('does not emit stage=canceled from a delivery the write-lock fails', async () => {
      // The failed delivery is retried; emitting here would count the
      // cancellation once per attempt.
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      setupCustomerRetrieve();
      mockSyncTenantStatusInProvisionedRegions.mockResolvedValue(
        regionSyncFailure(new Error('Aurora API error')),
      );

      await expect(deliver()).rejects.toThrow('tenant status sync failed for: aurora');

      expect(dunningEmissions()).toHaveLength(0);
    });

    it('labels canceled by cancellation_requested when voluntary', async () => {
      setupStripeEvent(
        'customer.subscription.deleted',
        mockSubscription({
          cancellation_details: { reason: 'cancellation_requested' },
        }),
      );
      setupCustomerRetrieve();

      await deliver();

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

      await deliver();

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

      await deliver();

      expect(dunningEmissions()[0]).toMatchObject({
        stage: 'recovered',
        reason: 'past_due',
        attemptBucket: '2',
      });
    });

    it('emits stage=recovered with reason=grace_period when prior status was grace_period', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice({ attempt_count: 4 }));
      setupCustomerRetrieve();
      ddbMock.on(UpdateItemCommand, { TableName: TABLE_NAME }).resolves({
        Attributes: marshall({ subscriptionStatus: SubscriptionStatus.GracePeriod }),
      });

      await deliver();

      expect(dunningEmissions()[0]).toMatchObject({
        stage: 'recovered',
        reason: 'grace_period',
        attemptBucket: '4+',
      });
      // Aurora re-activation must still run
      expect(mockSyncTenantStatusInProvisionedRegions).toHaveBeenCalledWith(MOCK_ORG_ID, 'active');
    });

    it('does NOT emit recovered on normal renewal (prior status was active)', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice({ attempt_count: 1 }));
      setupCustomerRetrieve();
      ddbMock.on(UpdateItemCommand).resolves({
        Attributes: marshall({ subscriptionStatus: SubscriptionStatus.Active }),
      });

      await deliver();

      expect(dunningEmissions()).toHaveLength(0);
    });

    it('does NOT emit on unrelated events (customer.subscription.created)', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());

      await deliver();

      expect(dunningEmissions()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // InvoicePaid metric (EMF via reportMetric)
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

      await deliver();

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

    it('does not emit from a delivery the re-activation fails', async () => {
      // The failed delivery is retried; emitting here would count the payment
      // once per attempt.
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      setupCustomerRetrieve();
      mockSyncTenantStatusInProvisionedRegions.mockResolvedValue(
        regionSyncFailure(new Error('Aurora API error')),
      );

      await expect(deliver()).rejects.toThrow('tenant status sync failed for: aurora');

      expect(invoicePaidEmissions()).toHaveLength(0);
    });

    it('counts a payment once when the processed mark fails to write', async () => {
      // A failed delivery would be redelivered by SQS and emit the metric again.
      vi.spyOn(console, 'error').mockImplementationOnce(() => {});
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      setupCustomerRetrieve();
      ddbMock.on(PutItemCommand).rejectsOnce(new Error('ProvisionedThroughputExceeded'));

      await expect(deliver()).resolves.toBeUndefined();

      expect(invoicePaidEmissions()).toHaveLength(1);
    });

    it('does not emit even when invoice.customer is null', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice({ customer: null }));

      await deliver();

      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(invoicePaidEmissions()).toHaveLength(0);
    });

    it('does NOT emit on invoice.payment_failed', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoice({ attempt_count: 1 }));
      setupCustomerRetrieve();

      await deliver();

      expect(invoicePaidEmissions()).toHaveLength(0);
    });

    it('does NOT emit on unrelated events (customer.subscription.created)', async () => {
      setupStripeEvent('customer.subscription.created', mockSubscription());

      await deliver();

      expect(invoicePaidEmissions()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // InvoiceFinalized metric (EMF via reportMetric)
  // -----------------------------------------------------------------------
  describe('InvoiceFinalized metric', () => {
    function invoiceFinalizedEmissions(): MetricEvent[] {
      return reportMetricMock.mock.calls
        .map(([event]) => event)
        .filter((e) => (e as { InvoiceFinalized?: unknown }).InvoiceFinalized === 1);
    }

    it('emits one InvoiceFinalized event on invoice.finalized', async () => {
      setupStripeEvent('invoice.finalized', mockInvoice());

      await deliver();

      const emissions = invoiceFinalizedEmissions();
      expect(emissions).toHaveLength(1);
      expect(emissions[0]).toMatchObject({ InvoiceFinalized: 1 });
      expect(emissions[0]._aws).toMatchObject({
        CloudWatchMetrics: [
          {
            Namespace: 'FilOne',
            Dimensions: [[]],
            Metrics: [{ Name: 'InvoiceFinalized', Unit: 'Count' }],
          },
        ],
      });
    });

    it('does NOT emit on invoice.finalization_failed', async () => {
      setupStripeEvent('invoice.finalization_failed', mockInvoice());

      await deliver();

      expect(invoiceFinalizedEmissions()).toHaveLength(0);
    });

    it('does NOT emit on invoice.payment_succeeded', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      setupCustomerRetrieve();

      await deliver();

      expect(invoiceFinalizedEmissions()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // InvoiceFinalizationFailed metric (EMF via reportMetric)
  // -----------------------------------------------------------------------
  describe('InvoiceFinalizationFailed metric', () => {
    function invoiceFinalizationFailedEmissions(): MetricEvent[] {
      return reportMetricMock.mock.calls
        .map(([event]) => event)
        .filter(
          (e) => (e as { InvoiceFinalizationFailed?: unknown }).InvoiceFinalizationFailed === 1,
        );
    }

    it('emits with reason from last_finalization_error.code', async () => {
      setupStripeEvent(
        'invoice.finalization_failed',
        mockInvoice({ last_finalization_error: { code: 'tax_calculation_failed' } }),
      );

      await deliver();

      const emissions = invoiceFinalizationFailedEmissions();
      expect(emissions).toHaveLength(1);
      expect(emissions[0]).toMatchObject({
        reason: 'tax_calculation_failed',
        InvoiceFinalizationFailed: 1,
      });
      expect(emissions[0]._aws).toMatchObject({
        CloudWatchMetrics: [
          {
            Namespace: 'FilOne',
            Dimensions: [['reason']],
            Metrics: [{ Name: 'InvoiceFinalizationFailed', Unit: 'Count' }],
          },
        ],
      });
    });

    it('emits with reason="unknown" when last_finalization_error missing', async () => {
      setupStripeEvent('invoice.finalization_failed', mockInvoice());

      await deliver();

      expect(invoiceFinalizationFailedEmissions()[0]).toMatchObject({
        reason: 'unknown',
      });
    });

    it('does NOT emit on invoice.finalized', async () => {
      setupStripeEvent('invoice.finalized', mockInvoice());

      await deliver();

      expect(invoiceFinalizationFailedEmissions()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // orgId backfill — the org id keys the row, and every lifecycle job
  // reads the attribute off it, so each writer stamps it from Stripe metadata.
  // if_not_exists is the do-not-overwrite guarantee: a stored orgId wins over
  // whatever the metadata carries. Metadata that names no org names no row
  // either, and that write is refused outright.
  // -----------------------------------------------------------------------
  describe('orgId backfill', () => {
    let errorSpy: MockInstance;

    beforeEach(() => {
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    function expectOrgIdBackfilled() {
      expect(updatedKeys()).toEqual([ORG_KEY]);
      const input = updateInputs()[0];
      expect(input.UpdateExpression).toContain('orgId = if_not_exists(orgId, :orgId)');
      expect(input.ExpressionAttributeValues![':orgId']).toEqual({ S: MOCK_ORG_ID });
    }

    // A key built from a guessed org would put this subscription on another
    // org's partition, so nothing is written — and the delivery fails rather than
    // reporting success. The event stays unmarked, so it is retried and then
    // parked in the DLQ, where it can be redriven once the metadata is repaired.
    // Swallowing it consumes the event and the status change with it.
    async function expectRefusedAndRetryable(delivery: Promise<void>) {
      await expect(delivery).rejects.toThrow(MissingOrgIdError);
      expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    }

    it('subscription update persists orgId from subscription metadata when present', async () => {
      setupStripeEvent(
        'customer.subscription.updated',
        mockSubscription({ metadata: { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID } }),
      );

      await deliver();

      expectOrgIdBackfilled();
    });

    it('subscription update persists orgId from customer metadata on the fallback path', async () => {
      setupStripeEvent('customer.subscription.updated', mockSubscription({ metadata: {} }));
      setupCustomerRetrieve();

      await deliver();

      expectOrgIdBackfilled();
    });

    // A subscription created before the metadata stamped an orgId still names
    // its user, and that alone used to take the no-fetch path and reach the
    // store with no org — a permanent 500 for every status change on every
    // legacy subscription. The customer is where the org actually is.
    it('subscription update falls back to customer metadata when the subscription names only the user', async () => {
      setupStripeEvent(
        'customer.subscription.updated',
        mockSubscription({ metadata: { userId: MOCK_USER_ID } }),
      );
      setupCustomerRetrieve();

      await deliver();

      expectOrgIdBackfilled();
      expect(mockCustomersRetrieve).toHaveBeenCalledTimes(1);
    });

    it('subscription update writes nothing when neither the subscription nor the customer names an org', async () => {
      setupStripeEvent(
        'customer.subscription.updated',
        mockSubscription({ metadata: { userId: MOCK_USER_ID } }),
      );
      setupCustomerRetrieveWithoutOrg();

      await expectRefusedAndRetryable(deliver());
    });

    it('subscription deleted persists orgId from customer metadata', async () => {
      setupStripeEvent('customer.subscription.deleted', mockSubscription());
      setupCustomerRetrieve();

      await deliver();

      expectOrgIdBackfilled();
    });

    it('subscription deleted writes nothing when metadata carries no orgId', async () => {
      setupStripeEvent(
        'customer.subscription.deleted',
        mockSubscription({ metadata: { userId: MOCK_USER_ID } }),
      );
      setupCustomerRetrieveWithoutOrg();

      await expectRefusedAndRetryable(deliver());
    });

    it('payment succeeded persists orgId from customer metadata', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      setupCustomerRetrieve();

      await deliver();

      expectOrgIdBackfilled();
    });

    // Stripe snapshots the subscription's metadata onto the invoice, so an
    // invoice for a customer created before the metadata carried an orgId still
    // names the org it is paying for.
    it('payment succeeded persists orgId from the invoice subscription metadata', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoiceForOrgSubscription());
      setupCustomerRetrieveWithoutOrg();

      await deliver();

      expectOrgIdBackfilled();
    });

    it('payment succeeded writes nothing when metadata carries no orgId', async () => {
      setupStripeEvent('invoice.payment_succeeded', mockInvoice());
      setupCustomerRetrieveWithoutOrg();

      await expectRefusedAndRetryable(deliver());
    });

    it('payment failed persists orgId from customer metadata', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoice());
      setupCustomerRetrieve();

      await deliver();

      expectOrgIdBackfilled();
    });

    it('payment failed persists orgId from the invoice subscription metadata', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoiceForOrgSubscription());
      setupCustomerRetrieveWithoutOrg();

      await deliver();

      expectOrgIdBackfilled();
    });

    it('payment failed writes nothing when metadata carries no orgId', async () => {
      setupStripeEvent('invoice.payment_failed', mockInvoice());
      setupCustomerRetrieveWithoutOrg();

      await expectRefusedAndRetryable(deliver());
    });
  });
});
