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

/** The org's row — the only row a read can land on. */
function subscriptionItem(overrides: Record<string, unknown> = {}) {
  return {
    Item: marshall({
      pk: `ORG#${USER_INFO.orgId}`,
      sk: 'SUBSCRIPTION',
      orgId: USER_INFO.orgId,
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

  it('lists an unpaid invoice, which is the one a failed payment is about', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolves(subscriptionItem({ stripeCustomerId: 'cus_456', subscriptionStatus: 'past_due' }));
    mockInvoicesList.mockResolvedValue({
      data: [
        { id: 'in_open', amount_due: 2096, status: 'open', created: 1767225600, invoice_pdf: null },
        { id: 'in_paid', amount_due: 1874, status: 'paid', created: 1764547200, invoice_pdf: null },
      ],
    });

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const body = JSON.parse(String(result.body));
    expect(body.invoices.map((i: { id: string }) => i.id)).toEqual(['in_open', 'in_paid']);
  });

  it('leaves out a draft, which Stripe has not finalised into a bill', async () => {
    ddbMock
      .on(GetItemCommand)
      .resolves(subscriptionItem({ stripeCustomerId: 'cus_456', subscriptionStatus: 'active' }));
    mockInvoicesList.mockResolvedValue({
      data: [
        {
          id: 'in_draft',
          amount_due: 500,
          status: 'draft',
          created: 1767225600,
          invoice_pdf: null,
        },
        { id: 'in_paid', amount_due: 1874, status: 'paid', created: 1764547200, invoice_pdf: null },
      ],
    });

    const result = await baseHandler(buildEvent({ userInfo: USER_INFO }));

    const body = JSON.parse(String(result.body));
    expect(body.invoices.map((i: { id: string }) => i.id)).toEqual(['in_paid']);
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
      limit: 12,
    });
  });
});
