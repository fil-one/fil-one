import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { AuthenticatedEvent } from '../lib/user-context.js';
import { ApiErrorCode } from '@filone/shared';
import { buildEvent, buildMiddyRequest } from '../test/lambda-test-utilities.js';
import { expectErrorResponse } from '../test/assert-helpers.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
  },
}));

vi.mock('../lib/user-context.js', () => ({
  getUserInfo: (event: AuthenticatedEvent) => event.requestContext.userInfo,
}));

vi.mock('../lib/create-billing-trial.js', () => ({
  createBillingTrial: vi.fn(),
}));

const ddbMock = mockClient(DynamoDBClient);

import { subscriptionGuardMiddleware, AccessLevel } from './subscription-guard.js';
import { createBillingTrial } from '../lib/create-billing-trial.js';
import { SubscriptionStatus } from '@filone/shared';

const mockCreateBillingTrial = vi.mocked(createBillingTrial);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function billingItem(fields: Parameters<typeof marshall>[0]) {
  return { Item: marshall(fields, { removeUndefinedValues: true }) };
}

const USER_ID = 'test-user-uuid';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subscriptionGuardMiddleware', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.restoreAllMocks();
  });

  it('allows when no billing record exists and fires createBillingTrial', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    mockCreateBillingTrial.mockResolvedValue(undefined);

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
    const request = buildMiddyRequest(
      buildEvent({
        userInfo: { userId: USER_ID, orgId: 'test-org-uuid', email: 'test@example.com' },
      }),
    );
    const result = await before(request);

    expect(result).toBeUndefined();
    expect(mockCreateBillingTrial).toHaveBeenCalledWith({
      userId: USER_ID,
      orgId: 'test-org-uuid',
      email: 'test@example.com',
    });
    expect(request.internal.billingTrialPromise).toBeDefined();
  });

  it('logs error but allows access when trial creation fails in fallback', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    const trialError = new Error('Stripe unavailable');
    mockCreateBillingTrial.mockRejectedValue(trialError);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { before, after } = subscriptionGuardMiddleware(AccessLevel.Write);
    const request = buildMiddyRequest(
      buildEvent({
        userInfo: { userId: USER_ID, orgId: 'test-org-uuid', email: 'test@example.com' },
      }),
    );

    const beforeResult = await before(request);
    expect(beforeResult).toBeUndefined();

    await after!(request);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[subscription-guard] Failed to create billing trial in subscription guard fallback:',
      trialError,
    );
  });

  it('after hook awaits the billing trial promise', async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: undefined });
    let resolved = false;
    mockCreateBillingTrial.mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            resolved = true;
            resolve();
          }, 10),
        ),
    );

    const { before, after } = subscriptionGuardMiddleware(AccessLevel.Write);
    const request = buildMiddyRequest(
      buildEvent({
        userInfo: { userId: USER_ID, orgId: 'test-org-uuid', email: 'test@example.com' },
      }),
    );

    await before(request);
    expect(resolved).toBe(false);

    await after!(request);
    expect(resolved).toBe(true);
  });

  it('allows when subscription status is active', async () => {
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `CUSTOMER#${USER_ID}`,
        sk: 'SUBSCRIPTION',
        subscriptionStatus: SubscriptionStatus.Active,
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expect(result).toBeUndefined();
  });

  it('allows when trialing and trial has not expired', async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `CUSTOMER#${USER_ID}`,
        sk: 'SUBSCRIPTION',
        subscriptionStatus: SubscriptionStatus.Trialing,
        trialEndsAt: futureDate,
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expect(result).toBeUndefined();
  });

  it('transitions trialing → grace_period when trial expired', async () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();

    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `CUSTOMER#${USER_ID}`,
        sk: 'SUBSCRIPTION',
        subscriptionStatus: SubscriptionStatus.Trialing,
        trialEndsAt: pastDate,
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});

    const { before } = subscriptionGuardMiddleware(AccessLevel.Read);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    // Read access during grace period → allowed
    expect(result).toBeUndefined();

    // Verify UpdateItemCommand was called to transition status
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input).toStrictEqual({
      TableName: 'BillingTable',
      Key: {
        pk: { S: `CUSTOMER#${USER_ID}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression:
        'SET subscriptionStatus = :status, gracePeriodEndsAt = :grace, updatedAt = :now',
      ExpressionAttributeValues: {
        ':status': { S: SubscriptionStatus.GracePeriod },
        ':grace': { S: expect.any(String) },
        ':now': { S: expect.any(String) },
      },
    });
  });

  it('blocks write access during grace period', async () => {
    const futureGrace = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `CUSTOMER#${USER_ID}`,
        sk: 'SUBSCRIPTION',
        subscriptionStatus: SubscriptionStatus.GracePeriod,
        gracePeriodEndsAt: futureGrace,
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expectErrorResponse(result, 403, {
      message:
        'Your account is in a grace period. Read-only access is available. Please reactivate your subscription to make changes.',
      code: ApiErrorCode.GRACE_PERIOD_WRITE_BLOCKED,
    });
  });

  it('allows read access during grace period', async () => {
    const futureGrace = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `CUSTOMER#${USER_ID}`,
        sk: 'SUBSCRIPTION',
        subscriptionStatus: SubscriptionStatus.GracePeriod,
        gracePeriodEndsAt: futureGrace,
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Read);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expect(result).toBeUndefined();
  });

  it('transitions grace_period → canceled when grace expired, returns 403', async () => {
    const pastGrace = new Date(Date.now() - 1000).toISOString();
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `CUSTOMER#${USER_ID}`,
        sk: 'SUBSCRIPTION',
        subscriptionStatus: SubscriptionStatus.GracePeriod,
        gracePeriodEndsAt: pastGrace,
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});

    const { before } = subscriptionGuardMiddleware(AccessLevel.Read);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expectErrorResponse(result, 403, {
      message: 'Your subscription has been canceled. Please reactivate to regain access.',
      code: ApiErrorCode.SUBSCRIPTION_CANCELED,
    });

    // Verify transition to canceled
    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input).toStrictEqual({
      TableName: 'BillingTable',
      Key: {
        pk: { S: `CUSTOMER#${USER_ID}` },
        sk: { S: 'SUBSCRIPTION' },
      },
      UpdateExpression: 'SET subscriptionStatus = :status, updatedAt = :now',
      ExpressionAttributeValues: {
        ':status': { S: SubscriptionStatus.Canceled },
        ':now': { S: expect.any(String) },
      },
    });
  });

  it('allows when billing record exists but has no subscriptionStatus', async () => {
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `CUSTOMER#${USER_ID}`,
        sk: 'SUBSCRIPTION',
        stripeCustomerId: 'cus_123',
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Write);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expect(result).toBeUndefined();
  });

  it('blocks access when status is directly canceled (not via grace expiry)', async () => {
    ddbMock.on(GetItemCommand).resolves(
      billingItem({
        pk: `CUSTOMER#${USER_ID}`,
        sk: 'SUBSCRIPTION',
        subscriptionStatus: SubscriptionStatus.Canceled,
      }),
    );

    const { before } = subscriptionGuardMiddleware(AccessLevel.Read);
    const result = await before(
      buildMiddyRequest(buildEvent({ userInfo: { userId: USER_ID, orgId: 'test-org-uuid' } })),
    );

    expectErrorResponse(result, 403, {
      message: 'Your subscription has been canceled. Please reactivate to regain access.',
      code: ApiErrorCode.SUBSCRIPTION_CANCELED,
    });
  });
});
