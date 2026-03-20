import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  DeleteItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { buildEvent } from '../test/lambda-test-utilities.js';
import { SubscriptionStatus } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
  },
}));

const mockConstructEvent = vi.fn();
const mockCustomersRetrieve = vi.fn();

vi.mock('../lib/stripe-client.js', () => ({
  getStripeClient: () => ({
    webhooks: { constructEvent: mockConstructEvent },
    customers: { retrieve: mockCustomersRetrieve },
  }),
  getWebhookSecret: vi.fn().mockResolvedValue('whsec_test_fake'),
}));

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stripe-webhook handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});
    ddbMock.on(DeleteItemCommand).resolves({});
    mockConstructEvent.mockReset();
    mockCustomersRetrieve.mockReset();
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
});
