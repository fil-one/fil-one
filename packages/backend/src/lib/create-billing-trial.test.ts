import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { SubscriptionStatus } from '@filone/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCustomersCreate = vi.fn();
const mockSubscriptionsCreate = vi.fn();

vi.mock('./stripe-client.js', () => ({
  getStripeClient: () => ({
    customers: { create: mockCustomersCreate },
    subscriptions: { create: mockSubscriptionsCreate },
  }),
  getBillingSecrets: () => ({
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_PRICE_ID: 'price_test_fake',
  }),
}));

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
    StripeSecretKey: { value: 'sk_test_fake' },
    StripePriceId: { value: 'price_test_fake' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { createBillingTrial } from './create-billing-trial.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createBillingTrial', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();

    // Default: no existing billing record, so the guard falls through.
    ddbMock.on(GetItemCommand).resolves({});

    mockCustomersCreate.mockResolvedValue({ id: 'cus_test_123' });
    mockSubscriptionsCreate.mockResolvedValue({
      id: 'sub_test_123',
      items: {
        data: [{ current_period_start: 1700000000, current_period_end: 1701209600 }],
      },
    });
  });

  it('creates Stripe customer, subscription, and DynamoDB trial record', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await createBillingTrial({
      userId: 'user-1',
      orgId: 'org-1',
      email: 'test@example.com',
    });

    expect(result).toBe(SubscriptionStatus.Trialing);

    // Verify Stripe customer creation
    expect(mockCustomersCreate).toHaveBeenCalledWith(
      { email: 'test@example.com', metadata: { userId: 'user-1', orgId: 'org-1' } },
      { idempotencyKey: 'billing-trial-user-1' },
    );

    // Verify Stripe subscription creation
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_test_123',
        items: [{ price: 'price_test_fake' }],
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        metadata: { userId: 'user-1', orgId: 'org-1' },
      }),
      { idempotencyKey: 'billing-trial-sub-user-1' },
    );

    // Verify the DynamoDB upsert. A single UpdateItem both creates the record for
    // a fresh signup and heals an existing status-less record; the condition keeps
    // it a no-op once a status exists.
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);

    const input = updateCalls[0].args[0].input;
    expect(input.TableName).toBe('BillingTable');
    expect(input.Key).toEqual({ pk: { S: 'CUSTOMER#user-1' }, sk: { S: 'SUBSCRIPTION' } });
    expect(input.ConditionExpression).toBe('attribute_not_exists(subscriptionStatus)');
    expect(input.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');

    const values = input.ExpressionAttributeValues!;
    expect(values[':orgId']).toEqual({ S: 'org-1' });
    expect(values[':cid']).toEqual({ S: 'cus_test_123' });
    expect(values[':subId']).toEqual({ S: 'sub_test_123' });
    expect(values[':status']).toEqual({ S: SubscriptionStatus.Trialing });
    expect(values[':ts']).toBeDefined();
    expect(values[':te']).toBeDefined();
    expect(values[':cps']).toBeDefined();
    expect(values[':cpe']).toBeDefined();
    expect(values[':now']).toBeDefined();
  });

  it('sets trial_end to 30 days from now', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await createBillingTrial({ userId: 'user-1', orgId: 'org-1' });

    const trialEnd = mockSubscriptionsCreate.mock.calls[0][0].trial_end;
    const nowUnix = Math.floor(Date.now() / 1000);
    const thirtyDaysInSeconds = 30 * 24 * 60 * 60;

    // Allow 5 seconds of tolerance for test execution time
    expect(trialEnd).toBeGreaterThanOrEqual(nowUnix + thirtyDaysInSeconds - 5);
    expect(trialEnd).toBeLessThanOrEqual(nowUnix + thirtyDaysInSeconds + 5);
  });

  it('passes undefined email when not provided', async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    await createBillingTrial({ userId: 'user-1', orgId: 'org-1' });

    expect(mockCustomersCreate).toHaveBeenCalledWith(
      { email: undefined, metadata: { userId: 'user-1', orgId: 'org-1' } },
      { idempotencyKey: 'billing-trial-user-1' },
    );
  });

  it('no-ops and reports the winner status when a concurrent writer provisioned the record first', async () => {
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
        Item: { subscriptionStatus: { S: SubscriptionStatus.Active } },
      }),
    );

    // Should not throw — and must report the concurrent winner's status
    // (ALL_OLD on the condition failure), not assume Trialing.
    const result = await createBillingTrial({ userId: 'user-1', orgId: 'org-1' });
    expect(result).toBe(SubscriptionStatus.Active);

    // Stripe calls should still have been made (idempotent on Stripe side)
    expect(mockCustomersCreate).toHaveBeenCalledOnce();
    expect(mockSubscriptionsCreate).toHaveBeenCalledOnce();
  });

  it('returns early without touching Stripe when a fully-provisioned billing record already exists', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: 'CUSTOMER#user-1' },
        sk: { S: 'SUBSCRIPTION' },
        subscriptionStatus: { S: 'trialing' },
        stripeCustomerId: { S: 'cus_existing' },
      },
    });

    const result = await createBillingTrial({
      userId: 'user-1',
      orgId: 'org-1',
      email: 'test@example.com',
    });

    // Reports the record's actual status rather than assuming Trialing.
    expect(result).toBe(SubscriptionStatus.Trialing);

    // Guarded before any Stripe side effects — this is what prevents duplicate
    // customers/subscriptions on re-invocation past Stripe's idempotency window.
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);

    const getCalls = ddbMock.commandCalls(GetItemCommand);
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].args[0].input).toMatchObject({
      TableName: 'BillingTable',
      Key: { pk: { S: 'CUSTOMER#user-1' }, sk: { S: 'SUBSCRIPTION' } },
      ConsistentRead: true,
    });
  });

  it('reports the existing status (e.g. active) when the record is already provisioned', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: 'CUSTOMER#user-1' },
        sk: { S: 'SUBSCRIPTION' },
        subscriptionStatus: { S: SubscriptionStatus.Active },
        stripeCustomerId: { S: 'cus_existing' },
      },
    });

    const result = await createBillingTrial({ userId: 'user-1', orgId: 'org-1' });

    expect(result).toBe(SubscriptionStatus.Active);
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('heals a bare record (stripeCustomerId, no subscriptionStatus): reuses customer, issues UpdateItemCommand', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: 'CUSTOMER#user-1' },
        sk: { S: 'SUBSCRIPTION' },
        stripeCustomerId: { S: 'cus_bare_existing' },
      },
    });
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await createBillingTrial({
      userId: 'user-1',
      orgId: 'org-1',
      email: 'test@example.com',
    });

    expect(result).toBe(SubscriptionStatus.Trialing);

    // Must NOT create a new Stripe customer (reuses the bare record's customerId)
    expect(mockCustomersCreate).not.toHaveBeenCalled();

    // Must still create the Stripe subscription (using the reused customer)
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_bare_existing' }),
      { idempotencyKey: 'billing-trial-sub-user-1' },
    );

    // Must use UpdateItemCommand, not PutItemCommand
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);

    const input = updateCalls[0].args[0].input;
    expect(input.TableName).toBe('BillingTable');
    expect(input.Key).toEqual({ pk: { S: 'CUSTOMER#user-1' }, sk: { S: 'SUBSCRIPTION' } });
    expect(input.ConditionExpression).toBe('attribute_not_exists(subscriptionStatus)');
    expect(input.ExpressionAttributeValues?.[':status']).toEqual({ S: 'trialing' });
    expect(input.ExpressionAttributeValues?.[':subId']).toEqual({ S: 'sub_test_123' });
    expect(input.ExpressionAttributeValues?.[':ts']).toBeDefined();
    expect(input.ExpressionAttributeValues?.[':te']).toBeDefined();
    expect(input.ExpressionAttributeValues?.[':cps']).toBeDefined();
    expect(input.ExpressionAttributeValues?.[':cpe']).toBeDefined();
    expect(input.ExpressionAttributeValues?.[':now']).toBeDefined();
  });

  it('heals a status-less record with no stripeCustomerId: creates a customer and backfills via UpdateItem', async () => {
    // A record that exists without stripeCustomerId AND without subscriptionStatus.
    // The upsert must fill in the trial and backfill the customer id without
    // clobbering, leaving the record canonical.
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: 'CUSTOMER#user-1' },
        sk: { S: 'SUBSCRIPTION' },
      },
    });
    ddbMock.on(UpdateItemCommand).resolves({});

    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', email: 'test@example.com' });

    // No existing customer on the record → a new Stripe customer is created.
    expect(mockCustomersCreate).toHaveBeenCalledOnce();
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_test_123' }),
      { idempotencyKey: 'billing-trial-sub-user-1' },
    );

    // Heals via UpdateItem, never PutItem.
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);

    const input = updateCalls[0].args[0].input;
    expect(input.ConditionExpression).toBe('attribute_not_exists(subscriptionStatus)');
    // Backfills stripeCustomerId/orgId without clobbering (if_not_exists).
    expect(input.UpdateExpression).toContain(
      'stripeCustomerId = if_not_exists(stripeCustomerId, :cid)',
    );
    expect(input.UpdateExpression).toContain('orgId = if_not_exists(orgId, :orgId)');
    expect(input.ExpressionAttributeValues?.[':cid']).toEqual({ S: 'cus_test_123' });
    expect(input.ExpressionAttributeValues?.[':orgId']).toEqual({ S: 'org-1' });
  });

  it('heals a bare record: no-ops with the winner status when a concurrent writer already set subscriptionStatus', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: 'CUSTOMER#user-1' },
        sk: { S: 'SUBSCRIPTION' },
        stripeCustomerId: { S: 'cus_bare_existing' },
      },
    });
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
        Item: { subscriptionStatus: { S: SubscriptionStatus.Trialing } },
      }),
    );

    // Should not throw
    const result = await createBillingTrial({ userId: 'user-1', orgId: 'org-1' });
    expect(result).toBe(SubscriptionStatus.Trialing);

    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).toHaveBeenCalledOnce();
  });

  it('propagates Stripe customer creation errors', async () => {
    mockCustomersCreate.mockRejectedValue(new Error('Stripe API error'));

    await expect(createBillingTrial({ userId: 'user-1', orgId: 'org-1' })).rejects.toThrow(
      'Stripe API error',
    );

    // Should not attempt subscription or DynamoDB
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('propagates Stripe subscription creation errors', async () => {
    mockSubscriptionsCreate.mockRejectedValue(new Error('Subscription failed'));

    await expect(createBillingTrial({ userId: 'user-1', orgId: 'org-1' })).rejects.toThrow(
      'Subscription failed',
    );

    // Customer was created but DynamoDB should not have been called
    expect(mockCustomersCreate).toHaveBeenCalledOnce();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('propagates unexpected DynamoDB errors', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('Service unavailable'));

    await expect(createBillingTrial({ userId: 'user-1', orgId: 'org-1' })).rejects.toThrow(
      'Service unavailable',
    );
  });
});
