import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
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
    UserInfoTable: { name: 'UserInfoTable' },
    StripeSecretKey: { value: 'sk_test_fake' },
    StripePriceId: { value: 'price_test_fake' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { createBillingTrial } from './create-billing-trial.js';

const USER_INFO = { sub: 'auth0|sub-1' };
const BILLING_KEY = { pk: { S: 'CUSTOMER#user-1' }, sk: { S: 'SUBSCRIPTION' } };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createBillingTrial', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();

    // Default: no existing billing record, so the guard falls through.
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({});
    // Default: a live identity for the FIL-112 post-write verification.
    ddbMock
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves({ Item: { userId: { S: 'user-1' } } });
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(DeleteItemCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});

    mockCustomersCreate.mockResolvedValue({ id: 'cus_test_123' });
    mockSubscriptionsCreate.mockResolvedValue({
      id: 'sub_test_123',
      items: {
        data: [{ current_period_start: 1700000000, current_period_end: 1701209600 }],
      },
    });
  });

  it('creates Stripe customer, subscription, and DynamoDB trial record', async () => {
    await createBillingTrial({
      userId: 'user-1',
      orgId: 'org-1',
      email: 'test@example.com',
      userInfo: USER_INFO,
    });

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

    // Verify DynamoDB write
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);

    const input = updateCalls[0].args[0].input;
    expect(input.TableName).toBe('BillingTable');
    expect(input.Key).toEqual({ pk: { S: 'CUSTOMER#user-1' }, sk: { S: 'SUBSCRIPTION' } });

    const values = input.ExpressionAttributeValues!;
    expect(values[':orgId']).toEqual({ S: 'org-1' });
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
    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO });

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
    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO });

    const input = ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.UpdateExpression).toContain(
      'subscriptionStatus = if_not_exists(subscriptionStatus, :status)',
    );
    expect(input.ExpressionAttributeValues![':status']).toEqual({
      S: SubscriptionStatus.Trialing,
    });
  });

  it('sets trial_end to 30 days from now', async () => {
    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO });

    const trialEnd = mockSubscriptionsCreate.mock.calls[0][0].trial_end;
    const nowUnix = Math.floor(Date.now() / 1000);
    const thirtyDaysInSeconds = 30 * 24 * 60 * 60;

    // Allow 5 seconds of tolerance for test execution time
    expect(trialEnd).toBeGreaterThanOrEqual(nowUnix + thirtyDaysInSeconds - 5);
    expect(trialEnd).toBeLessThanOrEqual(nowUnix + thirtyDaysInSeconds + 5);
  });

  it('passes undefined email when not provided', async () => {
    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO });

    expect(mockCustomersCreate).toHaveBeenCalledWith(
      { email: undefined, metadata: { userId: 'user-1', orgId: 'org-1' } },
      { idempotencyKey: 'billing-trial-user-1' },
    );
  });

  it('returns early without touching Stripe when a COMPLETE billing record exists', async () => {
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({
      Item: {
        pk: { S: 'CUSTOMER#user-1' },
        sk: { S: 'SUBSCRIPTION' },
        stripeCustomerId: { S: 'cus_existing' },
        subscriptionId: { S: 'sub_existing' },
      },
    });

    await createBillingTrial({
      userId: 'user-1',
      orgId: 'org-1',
      email: 'test@example.com',
      userInfo: USER_INFO,
    });

    // Guarded before any Stripe side effects — this is what prevents duplicate
    // customers/subscriptions on re-invocation past Stripe's idempotency window.
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);

    const getCalls = ddbMock.commandCalls(GetItemCommand);
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].args[0].input).toMatchObject({
      TableName: 'BillingTable',
      Key: { pk: { S: 'CUSTOMER#user-1' }, sk: { S: 'SUBSCRIPTION' } },
      ConsistentRead: true,
    });
  });

  it('propagates Stripe customer creation errors', async () => {
    mockCustomersCreate.mockRejectedValue(new Error('Stripe API error'));

    await expect(
      createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO }),
    ).rejects.toThrow('Stripe API error');

    // The early trial row is already written; only the Stripe fill-in is skipped.
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('propagates Stripe subscription creation errors', async () => {
    mockSubscriptionsCreate.mockRejectedValue(new Error('Subscription failed'));

    await expect(
      createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO }),
    ).rejects.toThrow('Subscription failed');

    // Customer was created but the Stripe fill-in write never ran.
    expect(mockCustomersCreate).toHaveBeenCalledOnce();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('propagates unexpected DynamoDB errors', async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error('Service unavailable'));

    await expect(
      createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO }),
    ).rejects.toThrow('Service unavailable');
  });

  // -------------------------------------------------------------------------
  // FIL-112: write the record first, then verify the identity survived
  // -------------------------------------------------------------------------

  it('writes a complete trialing record BEFORE any Stripe call', async () => {
    // Deletion-guarded webhook writers (attribute_exists(pk)) silently drop
    // their writes when no record exists. Writing first closes that hole for
    // the duration of the two Stripe round-trips.
    let putsWhenStripeWasCalled = -1;
    mockCustomersCreate.mockImplementation(() => {
      putsWhenStripeWasCalled = ddbMock.commandCalls(PutItemCommand).length;
      return Promise.resolve({ id: 'cus_test_123' });
    });

    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO });

    expect(putsWhenStripeWasCalled).toBe(1);

    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);

    const input = putCalls[0].args[0].input;
    expect(input.TableName).toBe('BillingTable');
    expect(input.ConditionExpression).toBe('attribute_not_exists(pk)');

    const item = input.Item!;
    expect(item.pk).toEqual({ S: 'CUSTOMER#user-1' });
    expect(item.sk).toEqual({ S: 'SUBSCRIPTION' });
    expect(item.orgId).toEqual({ S: 'org-1' });
    expect(item.subscriptionStatus).toEqual({ S: SubscriptionStatus.Trialing });
    expect(item.trialStartedAt?.S).toEqual(expect.any(String));
    expect(item.trialEndsAt?.S).toEqual(expect.any(String));

    const identityGets = ddbMock
      .commandCalls(GetItemCommand)
      .filter((c) => c.args[0].input.TableName === 'UserInfoTable');
    expect(identityGets).toHaveLength(1);
  });

  it('compensates the early row and skips Stripe when the identity is tombstoned', async () => {
    ddbMock
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves({ Item: { userId: { S: 'user-1' }, deleted: { BOOL: true } } });

    await expect(
      createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO }),
    ).resolves.toBeUndefined();

    const deleteCalls = ddbMock.commandCalls(DeleteItemCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input).toMatchObject({
      TableName: 'BillingTable',
      Key: BILLING_KEY,
    });
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('treats a missing identity row as tombstoned and compensates', async () => {
    // The deletion-confirm handler upserts the SUB# row, so an absent row means
    // the identity never existed.
    ddbMock.on(GetItemCommand, { TableName: 'UserInfoTable' }).resolves({});

    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO });

    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(1);
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('resumes rather than returning when the row is created concurrently', async () => {
    // Returning here is what made an incomplete row permanent. Resuming is safe
    // because both Stripe calls are idempotency-keyed per user, so the loser's
    // calls return the winner's customer and subscription rather than minting a
    // second pair.
    ddbMock.on(PutItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      }),
    );

    await expect(
      createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO }),
    ).resolves.toBeUndefined();

    expect(mockCustomersCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'billing-trial-user-1' }),
    );
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'billing-trial-sub-user-1' }),
    );
    expect(ddbMock.commandCalls(DeleteItemCommand)).toHaveLength(0);
  });

  it('preserves the original trial window on resume instead of restarting the clock', async () => {
    // The fill-in UpdateItem writes trialStartedAt/trialEndsAt unconditionally, so
    // recomputing them from `now` would silently reset the entitlement on every
    // resume — and hand Stripe a fresh trial_end to match.
    const originalStart = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const originalEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({
      Item: {
        pk: { S: 'CUSTOMER#user-1' },
        sk: { S: 'SUBSCRIPTION' },
        trialStartedAt: { S: originalStart },
        trialEndsAt: { S: originalEnd },
      },
    });

    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO });

    const fill = ddbMock
      .commandCalls(UpdateItemCommand)
      .map((c) => c.args[0].input)
      .find((input) => input.UpdateExpression?.includes('stripeCustomerId'));
    expect(fill?.ExpressionAttributeValues?.[':trialStartedAt']?.S).toBe(originalStart);
    expect(fill?.ExpressionAttributeValues?.[':trialEndsAt']?.S).toBe(originalEnd);
    // Stripe gets the same window, so the record and Stripe cannot diverge.
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ trial_end: Math.floor(new Date(originalEnd).getTime() / 1000) }),
      expect.anything(),
    );
  });

  it("clamps an elapsed window to Stripe's floor instead of failing forever", async () => {
    // Stripe rejects a trial_end under 48h out. Passing the stored value straight
    // through meant a resume from an old row was rejected on every attempt — the
    // unhealable row this rewrite exists to remove, relocated from "returns early
    // forever" to "errors forever".
    const elapsed = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({
      Item: {
        pk: { S: 'CUSTOMER#user-1' },
        sk: { S: 'SUBSCRIPTION' },
        trialStartedAt: { S: '2026-06-01T00:00:00.000Z' },
        trialEndsAt: { S: elapsed },
      },
    });

    await expect(
      createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO }),
    ).resolves.toBeUndefined();

    const trialEnd = mockSubscriptionsCreate.mock.calls[0][0].trial_end as number;
    expect(trialEnd * 1000).toBeGreaterThan(Date.now());
    // Bounded: ~48h, not another 30 days.
    expect(trialEnd * 1000).toBeLessThan(Date.now() + 3 * 24 * 60 * 60 * 1000);
    // The record and Stripe stay in step — one clamped value feeds both.
    const fill = ddbMock
      .commandCalls(UpdateItemCommand)
      .map((c) => c.args[0].input)
      .find((input) => input.UpdateExpression?.includes('stripeCustomerId'));
    const written = Date.parse(fill!.ExpressionAttributeValues![':trialEndsAt'].S!);
    expect(Math.floor(written / 1000)).toBe(trialEnd);
  });

  it('computes a fresh trial window on a first attempt', async () => {
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({});

    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO });

    const put = ddbMock.commandCalls(PutItemCommand)[0].args[0].input;
    const endsAt = new Date(put.Item!.trialEndsAt.S!).getTime();
    expect(endsAt).toBeGreaterThan(Date.now());
  });

  it('resumes provisioning for an existing row that has no Stripe pointers', async () => {
    // The defect this closes: a crash between the early PutItem and the Stripe
    // calls left a row with a valid local trial window and no
    // stripeCustomerId/subscriptionId, and the old existence-only guard made
    // every retry return early, so the pointers were never filled in.
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({
      Item: { pk: { S: 'CUSTOMER#user-1' }, sk: { S: 'SUBSCRIPTION' } },
    });

    await createBillingTrial({
      userId: 'user-1',
      orgId: 'org-1',
      email: 'test@example.com',
      userInfo: USER_INFO,
    });

    expect(mockCustomersCreate).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
    const fill = ddbMock
      .commandCalls(UpdateItemCommand)
      .map((c) => c.args[0].input)
      .find((input) => input.UpdateExpression?.includes('stripeCustomerId'));
    expect(fill?.ExpressionAttributeValues?.[':customerId']?.S).toBe('cus_test_123');
    expect(fill?.ExpressionAttributeValues?.[':subscriptionId']?.S).toBe('sub_test_123');
  });

  it('keeps the final write unconditional and if_not_exists-guarded on status', async () => {
    // Pinned: adding a ConditionExpression here would lose the Stripe pointers
    // at the writer instead of letting the resurrection sweep reconcile them.
    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO });

    const input = ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBeUndefined();
    expect(input.UpdateExpression).toContain(
      'subscriptionStatus = if_not_exists(subscriptionStatus, :status)',
    );
  });

  it('uses the same trial window in the early row and the final write', async () => {
    await createBillingTrial({ userId: 'user-1', orgId: 'org-1', userInfo: USER_INFO });

    const putItem = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
    const values =
      ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input.ExpressionAttributeValues!;

    expect(putItem.trialEndsAt).toEqual(values[':trialEndsAt']);
    expect(putItem.trialStartedAt).toEqual(values[':trialStartedAt']);
  });
});
