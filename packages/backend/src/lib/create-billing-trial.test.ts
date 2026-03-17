import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  PutItemCommand,
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

    mockCustomersCreate.mockResolvedValue({ id: 'cus_test_123' });
    mockSubscriptionsCreate.mockResolvedValue({
      id: 'sub_test_123',
      items: {
        data: [{ current_period_start: 1700000000, current_period_end: 1701209600 }],
      },
    });
  });

  it('creates Stripe customer, subscription, and DynamoDB trial record', async () => {
    ddbMock.on(PutItemCommand).resolves({});

    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', email: 'test@example.com' });

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

    // Verify DynamoDB put
    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);

    const input = putCalls[0].args[0].input;
    expect(input.TableName).toBe('BillingTable');
    expect(input.ConditionExpression).toBe('attribute_not_exists(pk)');

    const item = input.Item!;
    expect(item.pk).toEqual({ S: 'CUSTOMER#user-1' });
    expect(item.sk).toEqual({ S: 'SUBSCRIPTION' });
    expect(item.orgId).toEqual({ S: 'org-1' });
    expect(item.stripeCustomerId).toEqual({ S: 'cus_test_123' });
    expect(item.subscriptionId).toEqual({ S: 'sub_test_123' });
    expect(item.subscriptionStatus).toEqual({ S: SubscriptionStatus.Trialing });
    expect(item.trialStartedAt).toBeDefined();
    expect(item.trialEndsAt).toBeDefined();
    expect(item.currentPeriodStart).toBeDefined();
    expect(item.currentPeriodEnd).toBeDefined();
    expect(item.updatedAt).toBeDefined();
  });

  it('sets trial_end to 30 days from now', async () => {
    ddbMock.on(PutItemCommand).resolves({});

    await createBillingTrial({ userId: 'user-1', orgId: 'org-1' });

    const trialEnd = mockSubscriptionsCreate.mock.calls[0][0].trial_end;
    const nowUnix = Math.floor(Date.now() / 1000);
    const thirtyDaysInSeconds = 30 * 24 * 60 * 60;

    // Allow 5 seconds of tolerance for test execution time
    expect(trialEnd).toBeGreaterThanOrEqual(nowUnix + thirtyDaysInSeconds - 5);
    expect(trialEnd).toBeLessThanOrEqual(nowUnix + thirtyDaysInSeconds + 5);
  });

  it('passes undefined email when not provided', async () => {
    ddbMock.on(PutItemCommand).resolves({});

    await createBillingTrial({ userId: 'user-1', orgId: 'org-1' });

    expect(mockCustomersCreate).toHaveBeenCalledWith(
      { email: undefined, metadata: { userId: 'user-1', orgId: 'org-1' } },
      { idempotencyKey: 'billing-trial-user-1' },
    );
  });

  it('no-ops when DynamoDB record already exists', async () => {
    ddbMock.on(PutItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      }),
    );

    // Should not throw
    await createBillingTrial({ userId: 'user-1', orgId: 'org-1' });

    // Stripe calls should still have been made (idempotent on Stripe side)
    expect(mockCustomersCreate).toHaveBeenCalledOnce();
    expect(mockSubscriptionsCreate).toHaveBeenCalledOnce();
  });

  it('propagates Stripe customer creation errors', async () => {
    mockCustomersCreate.mockRejectedValue(new Error('Stripe API error'));

    await expect(createBillingTrial({ userId: 'user-1', orgId: 'org-1' })).rejects.toThrow(
      'Stripe API error',
    );

    // Should not attempt subscription or DynamoDB
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it('propagates Stripe subscription creation errors', async () => {
    mockSubscriptionsCreate.mockRejectedValue(new Error('Subscription failed'));

    await expect(createBillingTrial({ userId: 'user-1', orgId: 'org-1' })).rejects.toThrow(
      'Subscription failed',
    );

    // Customer was created but DynamoDB should not have been called
    expect(mockCustomersCreate).toHaveBeenCalledOnce();
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it('propagates unexpected DynamoDB errors', async () => {
    ddbMock.on(PutItemCommand).rejects(new Error('Service unavailable'));

    await expect(createBillingTrial({ userId: 'user-1', orgId: 'org-1' })).rejects.toThrow(
      'Service unavailable',
    );
  });
});
