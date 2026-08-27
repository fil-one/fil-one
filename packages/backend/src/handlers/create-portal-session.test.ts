import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

// baseHandler is tested directly, so the chain's auth and csrf middleware play
// no part here.

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
    StripeSecretKey: { value: 'sk_test_fake' },
  },
}));

const mockSessionsCreate = vi.fn();
vi.mock('../lib/stripe-client.js', () => ({
  getStripeClient: () => ({ billingPortal: { sessions: { create: mockSessionsCreate } } }),
  getBillingSecrets: () => ({ STRIPE_SECRET_KEY: 'sk_test_fake' }),
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './create-portal-session.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };
const ORG_KEY = { pk: { S: 'ORG#org-1' }, sk: { S: 'SUBSCRIPTION' } };

function portalEvent() {
  return buildEvent({
    userInfo: USER_INFO,
    method: 'POST',
    rawPath: '/api/billing/portal-session',
  });
}

function subscriptionRow(attributes: Record<string, unknown> = {}) {
  return {
    Item: marshall({ pk: ORG_KEY.pk.S, sk: 'SUBSCRIPTION', orgId: 'org-1', ...attributes }),
  };
}

describe('create-portal-session', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.clearAllMocks();
    process.env.WEBSITE_URL = 'https://app.example.com';
  });

  it('returns the portal URL for the org’s stored Stripe customer', async () => {
    ddbMock.on(GetItemCommand).resolves(subscriptionRow({ stripeCustomerId: 'cus_org_1' }));
    mockSessionsCreate.mockResolvedValue({ url: 'https://billing.stripe.com/session/abc' });

    const result = await baseHandler(portalEvent());

    expect(ddbMock.commandCalls(GetItemCommand)[0].args[0].input.Key).toStrictEqual(ORG_KEY);
    expect(mockSessionsCreate).toHaveBeenCalledWith({
      customer: 'cus_org_1',
      return_url: 'https://app.example.com/billing?portal_return=true',
    });
    expect(result).toMatchObject({ statusCode: 200 });
    expect(JSON.parse(String((result as { body: string }).body))).toStrictEqual({
      url: 'https://billing.stripe.com/session/abc',
    });
  });

  it('refuses when the org has no billing record', async () => {
    ddbMock.on(GetItemCommand).resolves({});

    const result = await baseHandler(portalEvent());

    expect(result).toMatchObject({ statusCode: 400 });
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it('refuses when the record names no Stripe customer', async () => {
    // A record can exist without one — the webhook upserts status before the
    // customer mapping is written. There is nothing to open a portal on.
    ddbMock.on(GetItemCommand).resolves(subscriptionRow({ subscriptionStatus: 'active' }));

    const result = await baseHandler(portalEvent());

    expect(result).toMatchObject({ statusCode: 400 });
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });
});
