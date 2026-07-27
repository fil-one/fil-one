import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { SubscriptionStatus } from '@filone/shared';

vi.mock('sst', () => ({
  Resource: {
    UserInfoTable: { name: 'UserInfoTable' },
  },
}));

const mockCreateBillingTrial = vi.fn();
vi.mock('./create-billing-trial.js', () => ({
  createBillingTrial: (args: unknown) => mockCreateBillingTrial(args),
}));

const ddbMock = mockClient(DynamoDBClient);

import { ensureTrialEntitlement } from './trial-entitlement.js';
import { TrialEntitlementError } from './errors.js';

const BASE = {
  sub: 'auth0|sub-1',
  userId: 'user-1',
  orgId: 'org-1',
  email: 'User+tag@gmail.com', // normalizes to user@gmail.com
  emailVerified: true,
};

describe('ensureTrialEntitlement', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    mockCreateBillingTrial.mockResolvedValue(SubscriptionStatus.Trialing);
  });

  it('returns null and writes nothing when email is unverified', async () => {
    const result = await ensureTrialEntitlement({ ...BASE, emailVerified: false });

    expect(result).toBeNull();
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(mockCreateBillingTrial).not.toHaveBeenCalled();
  });

  it('returns null and writes nothing when email is null', async () => {
    const result = await ensureTrialEntitlement({ ...BASE, email: null });

    expect(result).toBeNull();
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it('claims the normalized key, creates the trial, and sets the flag when claim is won', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await ensureTrialEntitlement(BASE);

    expect(result).toBe(SubscriptionStatus.Trialing);

    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.Item).toStrictEqual({
      pk: { S: 'EMAIL_NORM#user@gmail.com' },
      sk: { S: 'TRIAL_ENTITLEMENT' },
      userId: { S: 'user-1' },
      createdAt: { S: expect.any(String) },
    });
    expect(putCalls[0].args[0].input.ConditionExpression).toBe('attribute_not_exists(pk)');

    expect(mockCreateBillingTrial).toHaveBeenCalledWith({
      userId: 'user-1',
      orgId: 'org-1',
      email: 'User+tag@gmail.com',
    });

    const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.UpdateExpression).toBe('SET emailEntitlementClaimed = :t');
  });

  it('does not create a trial when the key is already claimed by another account', async () => {
    ddbMock.on(PutItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'exists',
        $metadata: {},
        Item: { userId: { S: 'someone-else' } },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await ensureTrialEntitlement(BASE);

    expect(result).toBeNull();
    expect(mockCreateBillingTrial).not.toHaveBeenCalled();
    // Flag is still set so we stop re-checking this identity.
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
  });

  it('creates the trial when the existing claim is owned by the same user (retry)', async () => {
    ddbMock.on(PutItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'exists',
        $metadata: {},
        Item: { userId: { S: 'user-1' } },
      }),
    );
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await ensureTrialEntitlement(BASE);

    expect(result).toBe(SubscriptionStatus.Trialing);
    expect(mockCreateBillingTrial).toHaveBeenCalledOnce();
  });

  it('reports the actual record status when the billing record is already provisioned (e.g. Active)', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});
    mockCreateBillingTrial.mockResolvedValue(SubscriptionStatus.Active);

    const result = await ensureTrialEntitlement(BASE);

    expect(result).toBe(SubscriptionStatus.Active);
  });

  it('throws and does not set the flag on a transient claim error', async () => {
    ddbMock.on(PutItemCommand).rejects(new Error('Service unavailable'));

    await expect(ensureTrialEntitlement(BASE)).rejects.toThrow(TrialEntitlementError);
    expect(mockCreateBillingTrial).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it('throws and does not set the flag when trial creation fails', async () => {
    ddbMock.on(PutItemCommand).resolves({});
    mockCreateBillingTrial.mockRejectedValue(new Error('Stripe down'));

    await expect(ensureTrialEntitlement(BASE)).rejects.toThrow(TrialEntitlementError);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });
});
