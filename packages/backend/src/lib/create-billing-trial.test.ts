import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
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
    UserInfoTable: { name: 'UserInfoTable' },
    StripeSecretKey: { value: 'sk_test_fake' },
    StripePriceId: { value: 'price_test_fake' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { createBillingTrial } from './create-billing-trial.js';
import { OrgDeletingError } from './org-profile.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createBillingTrial', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();

    // Default: no existing billing record, so the guard falls through.
    ddbMock.on(GetItemCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});

    mockCustomersCreate.mockResolvedValue({ id: 'cus_test_123' });
    mockSubscriptionsCreate.mockResolvedValue({
      id: 'sub_test_123',
      items: {
        data: [{ current_period_start: 1700000000, current_period_end: 1701209600 }],
      },
    });
  });

  // The DynamoDB write below is deliberately unconditional, so it cannot be
  // guarded — and a Stripe customer minted here is invisible to teardown's
  // snapshot, so nothing would ever cancel or delete it.
  it('mints nothing for an org that is being deleted', async () => {
    ddbMock
      .on(GetItemCommand, { Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'PROFILE' } } })
      .resolves({ Item: { pk: { S: 'ORG#org-1' }, deleting: { BOOL: true } } });

    await expect(
      createBillingTrial({ userId: 'user-1', orgId: 'org-1', email: 'test@example.com' }),
    ).rejects.toBeInstanceOf(OrgDeletingError);

    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('creates Stripe customer, subscription, and DynamoDB trial record', async () => {
    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', email: 'test@example.com' });

    // Verify Stripe customer creation
    expect(mockCustomersCreate).toHaveBeenCalledWith(
      { email: 'test@example.com', metadata: { userId: 'user-1', orgId: 'org-1' } },
      { idempotencyKey: 'billing-trial-org-org-1' },
    );

    // Verify Stripe subscription creation
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_test_123',
        items: [{ price: 'price_test_fake' }],
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        metadata: { userId: 'user-1', orgId: 'org-1' },
      }),
      { idempotencyKey: 'billing-trial-sub-org-org-1' },
    );

    // Verify the DynamoDB write: the org's row, created whole rather than
    // conditioned on already existing — this is the writer that brings it into
    // being.
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.Key).toStrictEqual({
      pk: { S: 'ORG#org-1' },
      sk: { S: 'SUBSCRIPTION' },
    });
    expect(updateCalls[0].args[0].input.ConditionExpression).toBeUndefined();

    const input = updateCalls[0].args[0].input;
    expect(input.TableName).toBe('BillingTable');

    const values = input.ExpressionAttributeValues!;
    expect(values[':orgId']).toEqual({ S: 'org-1' });
    expect(values[':userId']).toEqual({ S: 'user-1' });
    expect(values[':customerId']).toEqual({ S: 'cus_test_123' });
    expect(values[':subscriptionId']).toEqual({ S: 'sub_test_123' });
    expect(values[':status']).toEqual({ S: SubscriptionStatus.Trialing });
    expect(values[':trialStartedAt']).toBeDefined();
    expect(values[':trialEndsAt']).toBeDefined();
    expect(values[':periodStart']).toEqual({ S: new Date(1700000000 * 1000).toISOString() });
    expect(values[':periodEnd']).toEqual({ S: new Date(1701209600 * 1000).toISOString() });
    expect(values[':now']).toBeDefined();
  });

  it('fills the customer mapping when a webhook already created a partial record', async () => {
    // The subscription webhook can land between our GetItem and our write,
    // upserting a partial record (status, no stripeCustomerId). The write must
    // be an unconditional update so the customer mapping is stored anyway — a
    // conditional put would silently no-op and lose it forever.
    await createBillingTrial({ userId: 'user-1', orgId: 'org-1' });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);

    const input = updateCalls[0].args[0].input;
    expect(input.ConditionExpression).toBeUndefined();
    expect(input.UpdateExpression).toContain('stripeCustomerId = :customerId');
    expect(input.ExpressionAttributeValues![':customerId']).toEqual({ S: 'cus_test_123' });
  });

  it('does not overwrite a subscription status written by a webhook', async () => {
    // A webhook may have already advanced the status (e.g. to active);
    // if_not_exists keeps the fresher webhook value.
    await createBillingTrial({ userId: 'user-1', orgId: 'org-1' });

    const input = ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.Key).toEqual({ pk: { S: 'ORG#org-1' }, sk: { S: 'SUBSCRIPTION' } });
    expect(input.UpdateExpression).toContain(
      'subscriptionStatus = if_not_exists(subscriptionStatus, :status)',
    );
    expect(input.ExpressionAttributeValues![':status']).toEqual({
      S: SubscriptionStatus.Trialing,
    });
  });

  it('sets trial_end to 30 days from now', async () => {
    await createBillingTrial({ userId: 'user-1', orgId: 'org-1' });

    const trialEnd = mockSubscriptionsCreate.mock.calls[0][0].trial_end;
    const nowUnix = Math.floor(Date.now() / 1000);
    const thirtyDaysInSeconds = 30 * 24 * 60 * 60;

    // Allow 5 seconds of tolerance for test execution time
    expect(trialEnd).toBeGreaterThanOrEqual(nowUnix + thirtyDaysInSeconds - 5);
    expect(trialEnd).toBeLessThanOrEqual(nowUnix + thirtyDaysInSeconds + 5);
  });

  it('passes undefined email when not provided', async () => {
    await createBillingTrial({ userId: 'user-1', orgId: 'org-1' });

    expect(mockCustomersCreate).toHaveBeenCalledWith(
      { email: undefined, metadata: { userId: 'user-1', orgId: 'org-1' } },
      { idempotencyKey: 'billing-trial-org-org-1' },
    );
  });

  it('returns early without touching Stripe when the org already has a subscription', async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: 'ORG#org-1' },
        sk: { S: 'SUBSCRIPTION' },
        subscriptionStatus: { S: SubscriptionStatus.Trialing },
      },
    });

    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', email: 'test@example.com' });

    // Guarded before any Stripe side effects — this is what prevents duplicate
    // customers/subscriptions on re-invocation past Stripe's idempotency window.
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);

    const getCalls = ddbMock.commandCalls(GetItemCommand);
    expect(getCalls[0].args[0].input).toMatchObject({
      TableName: 'BillingTable',
      Key: { pk: { S: 'ORG#org-1' }, sk: { S: 'SUBSCRIPTION' } },
      ConsistentRead: true,
    });
  });

  it('creates a trial for an org whose member happens to hold no record of their own', async () => {
    // The existence check asks about the org, so a second member joining an org
    // that has no billing yet is not mistaken for an account that already has a
    // trial — and the check reads exactly one key to decide.
    ddbMock.on(GetItemCommand).resolves({});

    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', email: 'test@example.com' });

    expect(mockCustomersCreate).toHaveBeenCalledOnce();
    // The deletion fence reads the org profile beside this; the existence
    // check itself reads exactly one billing key.
    const getCalls = ddbMock
      .commandCalls(GetItemCommand)
      .filter((call) => call.args[0].input.TableName === 'BillingTable');
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].args[0].input.Key).toStrictEqual({
      pk: { S: 'ORG#org-1' },
      sk: { S: 'SUBSCRIPTION' },
    });
  });

  it('grants the trial onto the customer mapping an abandoned payment modal left', async () => {
    // create-setup-intent writes a row with a Stripe customer and nothing else
    // when somebody opens the payment form and closes it. Treating that as a
    // subscription would forfeit the trial permanently for the one user who
    // looked at the pricing page first.
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pk: { S: 'ORG#org-1' },
        sk: { S: 'SUBSCRIPTION' },
        stripeCustomerId: { S: 'cus_from_setup_intent' },
      },
    });

    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', email: 'test@example.com' });

    // And it reuses that customer rather than creating a second one for the
    // same org — two customers is two Stripe meters billing the same usage.
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_from_setup_intent' }),
      expect.anything(),
    );
    const values =
      ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input.ExpressionAttributeValues!;
    expect(values[':customerId']).toEqual({ S: 'cus_from_setup_intent' });
  });

  it('keys Stripe idempotency to the org, so one person’s two orgs get two subscriptions', async () => {
    // A key naming only the user would hand the second org the first org's
    // customer and subscription — one Stripe meter billing two orgs' usage.
    await createBillingTrial({ userId: 'user-1', orgId: 'org-1' });
    await createBillingTrial({ userId: 'user-1', orgId: 'org-2' });

    expect(mockCustomersCreate.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
      'billing-trial-org-org-1',
      'billing-trial-org-org-2',
    ]);
    expect(mockSubscriptionsCreate.mock.calls.map((call) => call[1].idempotencyKey)).toEqual([
      'billing-trial-sub-org-org-1',
      'billing-trial-sub-org-org-2',
    ]);
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
