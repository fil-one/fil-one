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

// ---------------------------------------------------------------------------
// Mocks — baseHandler is tested directly, so no auth/csrf middleware needed.
// ---------------------------------------------------------------------------

const mockCustomersCreate = vi.fn();
const mockSetupIntentsCreate = vi.fn();
vi.mock('../lib/stripe-client.js', () => ({
  getStripeClient: () => ({
    customers: { create: mockCustomersCreate },
    setupIntents: { create: mockSetupIntentsCreate },
  }),
}));

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
    UserInfoTable: { name: 'UserInfoTable' },
    StripePublishableKey: { value: 'pk_test_123' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './create-setup-intent.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

function setupIntentEvent() {
  return buildEvent({
    userInfo: { userId: USER_ID, orgId: ORG_ID, email: 'user@example.com' },
    method: 'POST',
    rawPath: '/api/billing/setup-intent',
  });
}

describe('create-setup-intent baseHandler', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    mockCustomersCreate.mockResolvedValue({ id: 'cus_test_123' });
    mockSetupIntentsCreate.mockResolvedValue({ client_secret: 'seti_test_secret_abc' });
    // Live identity for the FIL-112 tombstone checks (top pre-check + post-write).
    ddbMock
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves({ Item: { userId: { S: USER_ID } } });
    ddbMock.on(DeleteItemCommand).resolves({});
    ddbMock.on(UpdateItemCommand).resolves({});
  });

  it('persists only the Stripe customer mapping and never grants a trial (first-time)', async () => {
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({}); // no existing billing record
    ddbMock.on(PutItemCommand).resolves({});

    const result = await baseHandler(setupIntentEvent());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(mockCustomersCreate).toHaveBeenCalledOnce();
    expect(mockSetupIntentsCreate).toHaveBeenCalledOnce();

    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(1);

    const input = putCalls[0].args[0].input;
    // Race guard: never clobber a record created by the entitlement path.
    expect(input.ConditionExpression).toBe('attribute_not_exists(pk)');

    const item = input.Item!;
    expect(item.pk).toEqual({ S: `CUSTOMER#${USER_ID}` });
    expect(item.stripeCustomerId).toEqual({ S: 'cus_test_123' });
    expect(item.orgId).toEqual({ S: ORG_ID });

    // The invariant: this endpoint must not write trial entitlement.
    expect(item.subscriptionStatus).toBeUndefined();
    expect(item.trialStartedAt).toBeUndefined();
    expect(item.trialEndsAt).toBeUndefined();
  });

  it('stamps userId and orgId on the Stripe customer (first-time)', async () => {
    // Webhook writers backfill orgId onto billing records from this metadata;
    // without it, webhook-born records are skipped by every lifecycle job.
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({});
    ddbMock.on(PutItemCommand).resolves({});

    await baseHandler(setupIntentEvent());

    expect(mockCustomersCreate).toHaveBeenCalledWith({
      email: 'user@example.com',
      metadata: { userId: USER_ID, orgId: ORG_ID },
    });
  });

  it('stamps userId and orgId on the Stripe customer (existing record without one)', async () => {
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({
      Item: { pk: { S: `CUSTOMER#${USER_ID}` }, sk: { S: 'SUBSCRIPTION' } },
    });

    await baseHandler(setupIntentEvent());

    expect(mockCustomersCreate).toHaveBeenCalledWith({
      email: 'user@example.com',
      metadata: { userId: USER_ID, orgId: ORG_ID },
    });
  });

  it('swallows ConditionalCheckFailedException when a record was created concurrently', async () => {
    // The entitlement path won the race and already wrote the record, so the
    // conditional PutItem fails. We must not fail the request — keep going and
    // return the SetupIntent.
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({}); // first-time branch
    ddbMock.on(PutItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      }),
    );

    const result = await baseHandler(setupIntentEvent());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(mockSetupIntentsCreate).toHaveBeenCalledOnce();
  });

  it('rethrows non-conditional DynamoDB errors', async () => {
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({});
    ddbMock.on(PutItemCommand).rejects(new Error('Service unavailable'));

    await expect(baseHandler(setupIntentEvent())).rejects.toThrow('Service unavailable');
    expect(mockSetupIntentsCreate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // FIL-112 deletion races
  // -------------------------------------------------------------------------

  it('returns 410 without minting a Stripe customer when the identity is tombstoned', async () => {
    ddbMock
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolves({ Item: { userId: { S: USER_ID }, deleted: { BOOL: true } } });

    const result = await baseHandler(setupIntentEvent());

    expect(result).toMatchObject({ statusCode: 410 });
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSetupIntentsCreate).not.toHaveBeenCalled();
  });

  it('returns 410 and no SetupIntent when the deletion guard rejects the mapping update', async () => {
    // Existing record without a stripeCustomerId; teardown claimed the record
    // between the read and this write.
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({
      Item: { pk: { S: `CUSTOMER#${USER_ID}` }, sk: { S: 'SUBSCRIPTION' } },
    });
    ddbMock.on(UpdateItemCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      }),
    );

    const result = await baseHandler(setupIntentEvent());

    expect(result).toMatchObject({ statusCode: 410 });
    expect(mockSetupIntentsCreate).not.toHaveBeenCalled();

    const input = ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_not_exists(deletionRequestedAt)',
    );
  });

  it('compensates the record and returns 410 when deletion lands after the write', async () => {
    // Live at the top pre-check, tombstoned by the post-write verification.
    ddbMock.reset();
    ddbMock.on(GetItemCommand, { TableName: 'BillingTable' }).resolves({});
    ddbMock
      .on(GetItemCommand, { TableName: 'UserInfoTable' })
      .resolvesOnce({ Item: { userId: { S: USER_ID } } })
      .resolves({ Item: { deleted: { BOOL: true } } });
    ddbMock.on(PutItemCommand).resolves({});
    ddbMock.on(DeleteItemCommand).resolves({});

    const result = await baseHandler(setupIntentEvent());

    expect(result).toMatchObject({ statusCode: 410 });
    expect(mockSetupIntentsCreate).not.toHaveBeenCalled();

    const deleteCalls = ddbMock.commandCalls(DeleteItemCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input).toMatchObject({
      TableName: 'BillingTable',
      Key: { pk: { S: `CUSTOMER#${USER_ID}` }, sk: { S: 'SUBSCRIPTION' } },
    });
  });
});
