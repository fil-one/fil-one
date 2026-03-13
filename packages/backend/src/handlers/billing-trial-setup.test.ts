import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
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

vi.mock('../lib/stripe-client.js', () => ({
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

import { handler } from './billing-trial-setup.js';
import { buildContext } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSQSEvent(body: object): SQSEvent {
  return {
    Records: [
      {
        messageId: 'msg-1',
        receiptHandle: 'handle-1',
        body: JSON.stringify(body),
        attributes: {} as SQSEvent['Records'][0]['attributes'],
        messageAttributes: {},
        md5OfBody: '',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-east-1:123:queue',
        awsRegion: 'us-east-1',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('billing-trial-setup handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.restoreAllMocks();

    mockCustomersCreate.mockResolvedValue({ id: 'cus_test_123' });
    mockSubscriptionsCreate.mockResolvedValue({
      id: 'sub_test_123',
      items: {
        data: [{ current_period_start: 1700000000, current_period_end: 1701209600 }],
      },
    });
  });

  it('creates Stripe customer, subscription, and trial record for new user', async () => {
    ddbMock.on(PutItemCommand).resolves({});

    const message = { userId: 'user-1', orgId: 'org-1', email: 'test@example.com' };
    await handler(buildSQSEvent(message), buildContext());

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

  it('no-ops when record already exists (ConditionalCheckFailedException)', async () => {
    ddbMock.on(PutItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      }),
    );

    const message = { userId: 'user-1', orgId: 'org-1' };
    // Should not throw
    await handler(buildSQSEvent(message), buildContext());
  });

  it('throws when batch contains more than one record', async () => {
    const event = buildSQSEvent({ userId: 'user-1', orgId: 'org-1' });
    event.Records.push({ ...event.Records[0], messageId: 'msg-2' });

    await expect(handler(event, buildContext())).rejects.toThrow(
      'Expected exactly 1 SQS record, got 2',
    );
  });

  it('propagates Stripe errors', async () => {
    mockCustomersCreate.mockRejectedValue(new Error('Stripe API error'));

    const message = { userId: 'user-1', orgId: 'org-1' };
    await expect(handler(buildSQSEvent(message), buildContext())).rejects.toThrow(
      'Stripe API error',
    );
  });

  it('propagates unexpected DynamoDB errors', async () => {
    ddbMock.on(PutItemCommand).rejects(new Error('Service unavailable'));

    const message = { userId: 'user-1', orgId: 'org-1' };
    await expect(handler(buildSQSEvent(message), buildContext())).rejects.toThrow(
      'Service unavailable',
    );
  });
});
