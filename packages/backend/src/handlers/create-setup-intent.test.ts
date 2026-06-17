import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
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
  });

  it('persists only the Stripe customer mapping and never grants a trial (first-time)', async () => {
    ddbMock.on(GetItemCommand).resolves({}); // no existing billing record
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

  it('swallows ConditionalCheckFailedException when a record was created concurrently', async () => {
    // The entitlement path won the race and already wrote the record, so the
    // conditional PutItem fails. We must not fail the request — keep going and
    // return the SetupIntent.
    ddbMock.on(GetItemCommand).resolves({}); // first-time branch
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
    ddbMock.on(GetItemCommand).resolves({});
    ddbMock.on(PutItemCommand).rejects(new Error('Service unavailable'));

    await expect(baseHandler(setupIntentEvent())).rejects.toThrow('Service unavailable');
    expect(mockSetupIntentsCreate).not.toHaveBeenCalled();
  });
});
