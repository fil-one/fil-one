import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => ({
  Resource: {
    BillingTable: { name: 'BillingTable' },
    StripeSecretKey: { value: 'sk_test_fake' },
    StripePriceId: { value: 'price_test_fake' },
  },
}));

const mockInvoicesList = vi.fn();

vi.mock('../lib/stripe-client.js', () => ({
  getStripeClient: () => ({
    invoices: { list: mockInvoicesList },
  }),
  getBillingSecrets: () => ({
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_PRICE_ID: 'price_test_fake',
  }),
}));

const ddbMock = mockClient(DynamoDBClient);

import { baseHandler } from './list-invoices.js';
import { buildEvent } from '../test/lambda-test-utilities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_INFO = { userId: 'user-1', orgId: 'org-1' };

function subscriptionItem(overrides: Record<string, unknown> = {}) {
  return {
    Item: marshall({
      pk: `CUSTOMER#${USER_INFO.userId}`,
      sk: 'SUBSCRIPTION',
      ...overrides,
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('list-invoices baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
  });

  it('returns empty invoices when no billing record exists', async () => {
    ddbMock.on(GetItemCommand).resolves({});

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({ invoices: [] });
  });

  it('returns empty invoices when no stripeCustomerId', async () => {
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        subscriptionStatus: 'trialing',
        trialEndsAt: '2026-04-01T00:00:00Z',
      }),
    );

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({ invoices: [] });
  });

  it('returns mapped invoices from Stripe', async () => {
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        stripeCustomerId: 'cus_123',
        subscriptionStatus: 'active',
      }),
    );

    mockInvoicesList.mockResolvedValue({
      data: [
        {
          id: 'inv_1',
          amount_due: 499,
          status: 'paid',
          created: 1711900800,
          invoice_pdf: 'https://stripe.com/invoice.pdf',
        },
        {
          id: 'inv_2',
          amount_due: 998,
          status: 'paid',
          created: 1709222400,
          invoice_pdf: null,
        },
      ],
    });

    const event = buildEvent({ userInfo: USER_INFO });
    const result = await baseHandler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(String(result.body));
    expect(body).toStrictEqual({
      invoices: [
        {
          id: 'inv_1',
          amountDueInCents: 499,
          status: 'paid',
          createdAt: new Date(1711900800 * 1000).toISOString(),
          invoicePdfUrl: 'https://stripe.com/invoice.pdf',
        },
        {
          id: 'inv_2',
          amountDueInCents: 998,
          status: 'paid',
          createdAt: new Date(1709222400 * 1000).toISOString(),
          invoicePdfUrl: null,
        },
      ],
    });
  });

  it('calls stripe.invoices.list with correct params', async () => {
    ddbMock.on(GetItemCommand).resolves(
      subscriptionItem({
        stripeCustomerId: 'cus_456',
        subscriptionStatus: 'active',
      }),
    );

    mockInvoicesList.mockResolvedValue({ data: [] });

    const event = buildEvent({ userInfo: USER_INFO });
    await baseHandler(event);

    expect(mockInvoicesList).toHaveBeenCalledWith({
      customer: 'cus_456',
      limit: 3,
      status: 'paid',
    });
  });
});
