import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
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
    StripePublishableKey: { value: 'pk_test_123' },
  },
}));

const ddbMock = mockClient(DynamoDBClient);

vi.mock('../middleware/auth.js', () => ({
  // Every gate downstream of the auth middleware returns its denials through
  // this helper, so the partial mock has to carry it.
  withRefreshedCookies: (_request: unknown, response: unknown) => response,
  authMiddleware: () => ({ before: () => undefined }),
}));

import { baseHandler, handler } from './create-setup-intent.js';
import { buildEvent, buildContext } from '../test/lambda-test-utilities.js';
import { describeRoleEnforcement } from '../test/role-enforcement.js';

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

/** The two keys the subscription row lives on while it moves to the org. */
const ORG_KEY = { pk: { S: `ORG#${ORG_ID}` }, sk: { S: 'SUBSCRIPTION' } };
const LEGACY_KEY = { pk: { S: `CUSTOMER#${USER_ID}` }, sk: { S: 'SUBSCRIPTION' } };

function setupIntentEvent() {
  return buildEvent({
    userInfo: { userId: USER_ID, orgId: ORG_ID, email: 'user@example.com' },
    method: 'POST',
    rawPath: '/api/billing/setup-intent',
  });
}

/** A stored row on one of the two keys. */
function subscriptionItem(key: typeof ORG_KEY, attributes: Record<string, { S: string }> = {}) {
  return { Item: { ...key, ...attributes } };
}

/** The partition keys the puts landed on, in the order the store wrote them. */
function putKeys() {
  return ddbMock.commandCalls(PutItemCommand).map((call) => call.args[0].input.Item?.pk?.S);
}

/** The partition keys the updates landed on, in the order the store wrote them. */
function updatedKeys() {
  return ddbMock.commandCalls(UpdateItemCommand).map((call) => call.args[0].input.Key?.pk?.S);
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

    // Both keys are born together, so the org row is whole from its first
    // write instead of a partial twin shadowing a complete legacy row.
    const putCalls = ddbMock.commandCalls(PutItemCommand);
    expect(putCalls).toHaveLength(2);
    expect(putKeys()).toStrictEqual([ORG_KEY.pk.S, LEGACY_KEY.pk.S]);

    for (const call of putCalls) {
      const input = call.args[0].input;
      // Race guard: never clobber a record created by the entitlement path.
      expect(input.ConditionExpression).toBe('attribute_not_exists(pk)');

      const item = input.Item!;
      expect(item.stripeCustomerId).toEqual({ S: 'cus_test_123' });
      expect(item.orgId).toEqual({ S: ORG_ID });
      expect(item.userId).toEqual({ S: USER_ID });

      // The invariant: this endpoint must not write trial entitlement.
      expect(item.subscriptionStatus).toBeUndefined();
      expect(item.trialStartedAt).toBeUndefined();
      expect(item.trialEndsAt).toBeUndefined();
    }
  });

  it('stamps userId and orgId on the Stripe customer (first-time)', async () => {
    // Webhook writers backfill orgId onto billing records from this metadata;
    // without it, webhook-born records are skipped by every lifecycle job.
    ddbMock.on(GetItemCommand).resolves({});
    ddbMock.on(PutItemCommand).resolves({});

    await baseHandler(setupIntentEvent());

    expect(mockCustomersCreate).toHaveBeenCalledWith({
      email: 'user@example.com',
      metadata: { userId: USER_ID, orgId: ORG_ID },
    });
  });

  it('stamps userId and orgId on the Stripe customer (existing record without one)', async () => {
    ddbMock.on(GetItemCommand).resolves(subscriptionItem(ORG_KEY));
    ddbMock.on(UpdateItemCommand).resolves({});

    await baseHandler(setupIntentEvent());

    expect(mockCustomersCreate).toHaveBeenCalledWith({
      email: 'user@example.com',
      metadata: { userId: USER_ID, orgId: ORG_ID },
    });
  });

  it('records the customer mapping on both keys when the record exists without one', async () => {
    ddbMock.on(GetItemCommand).resolves(subscriptionItem(ORG_KEY));
    ddbMock.on(UpdateItemCommand).resolves({});

    await baseHandler(setupIntentEvent());

    expect(updatedKeys()).toStrictEqual([ORG_KEY.pk.S, LEGACY_KEY.pk.S]);
    for (const call of ddbMock.commandCalls(UpdateItemCommand)) {
      expect(call.args[0].input.ExpressionAttributeValues?.[':cid']).toEqual({ S: 'cus_test_123' });
    }
  });

  it("uses the org's Stripe customer rather than the one on the caller's legacy row", async () => {
    // Billing belongs to the org: a member setting up a card must land on the
    // org's Stripe customer, not mint or reuse one of their own.
    ddbMock
      .on(GetItemCommand, { Key: ORG_KEY })
      .resolves(subscriptionItem(ORG_KEY, { stripeCustomerId: { S: 'cus_org_1' } }))
      .on(GetItemCommand, { Key: LEGACY_KEY })
      .resolves(subscriptionItem(LEGACY_KEY, { stripeCustomerId: { S: 'cus_legacy_9' } }));

    const result = await baseHandler(setupIntentEvent());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(mockSetupIntentsCreate).toHaveBeenCalledWith({
      customer: 'cus_org_1',
      usage: 'off_session',
    });
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
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
    // A row the backfill already copied to the org key is no reason to leave
    // the legacy key unwritten, so both are still attempted.
    expect(putKeys()).toStrictEqual([ORG_KEY.pk.S, LEGACY_KEY.pk.S]);
  });

  it('rethrows non-conditional DynamoDB errors', async () => {
    ddbMock.on(GetItemCommand).resolves({});
    ddbMock.on(PutItemCommand).rejects(new Error('Service unavailable'));

    await expect(baseHandler(setupIntentEvent())).rejects.toThrow('Service unavailable');
    expect(mockSetupIntentsCreate).not.toHaveBeenCalled();
    // The run stops before the legacy row moves, so the retry finds both keys
    // where it left them.
    expect(putKeys()).toStrictEqual([ORG_KEY.pk.S]);
  });
});

describeRoleEnforcement({
  permission: 'billing.manage',
  invoke: (membership) =>
    handler(
      buildEvent({ userInfo: { ...{ userId: 'user-1', orgId: 'org-1' }, membership } }),
      buildContext(),
    ),
});
