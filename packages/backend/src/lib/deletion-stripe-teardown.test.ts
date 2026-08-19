import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

vi.mock('sst', () => ({ Resource: { BillingTable: { name: 'BillingTable' } } }));

const order: string[] = [];
const mockDisableTenants = vi.fn(async () => {
  order.push('disable');
  return [];
});
const mockReportOrgUsage = vi.fn(async () => {
  order.push('report');
  return undefined;
});

// Both reach service-orchestrator-registry, which resolves SST Resource values at
// import time and cannot load under a stubbed Resource.
vi.mock('./region-helpers.js', () => ({
  syncTenantStatusInProvisionedRegions: (...args: unknown[]) => mockDisableTenants(...(args as [])),
}));
vi.mock('./org-usage-report.js', () => ({
  reportOrgUsage: (...args: unknown[]) => mockReportOrgUsage(...(args as [])),
}));

const mockSubscriptionsList = vi.fn();
const mockSubscriptionsCancel = vi.fn(async (id: string) => void order.push(`cancel:${id}`));
const mockInvoicesList = vi.fn();
const mockFinalize = vi.fn();
const mockPay = vi.fn(async () => void order.push('pay'));
const mockCustomersDel = vi.fn(async (id: string) => void order.push(`del:${id}`));
const mockCustomersRetrieve = vi.fn();
const mockPaymentMethodsList = vi.fn();

vi.mock('./stripe-client.js', () => ({
  getStripeClient: () => ({
    subscriptions: { list: mockSubscriptionsList, cancel: mockSubscriptionsCancel },
    invoices: { list: mockInvoicesList, finalizeInvoice: mockFinalize, pay: mockPay },
    customers: { del: mockCustomersDel, retrieve: mockCustomersRetrieve },
    paymentMethods: { list: mockPaymentMethodsList },
  }),
  isStripeResourceMissing: (err: unknown) =>
    (err as { code?: string } | null)?.code === 'resource_missing',
}));

const ddbMock = mockClient(DynamoDBClient);

import { tearDownStripe } from './deletion-stripe-teardown.js';

const ORG = 'org-1';
const CUSTOMER = 'cus_1';
const MEMBERS = [{ userId: 'user-1', sub: 'auth0|one', stripeCustomerId: CUSTOMER }];

describe('tearDownStripe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ddbMock.reset();
    order.length = 0;
    process.env.STRIPE_METER_EVENT_NAME = 'filone_storage';
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        subscriptionId: { S: 'sub_1' },
        currentPeriodStart: { S: '2026-08-01T00:00:00.000Z' },
      },
    });
    mockSubscriptionsList.mockResolvedValue({ data: [] });
    mockInvoicesList.mockResolvedValue({ data: [] });
    mockCustomersRetrieve.mockResolvedValue({ invoice_settings: {} });
    mockPaymentMethodsList.mockResolvedValue({ data: [] });
  });

  it('does nothing for a member with no Stripe customer', async () => {
    await tearDownStripe(ORG, [{ userId: 'user-1', sub: 'auth0|one' }]);

    expect(mockCustomersDel).not.toHaveBeenCalled();
    expect(mockSubscriptionsList).not.toHaveBeenCalled();
  });

  // customers.del cancels subscriptions itself, but silently and without an
  // invoice — the explicit cancel is what makes the usage billable.
  it('cancels with invoice_now so the trailing usage is billed', async () => {
    mockSubscriptionsList.mockResolvedValue({
      data: [{ id: 'sub_1', status: 'active', default_payment_method: 'pm_1' }],
    });

    await tearDownStripe(ORG, MEMBERS);

    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_1', {
      invoice_now: true,
      prorate: false,
    });
  });

  it('skips subscriptions with nothing left to settle', async () => {
    mockSubscriptionsList.mockResolvedValue({
      data: [
        { id: 'sub_done', status: 'canceled' },
        { id: 'sub_dead', status: 'incomplete_expired' },
      ],
    });

    await tearDownStripe(ORG, MEMBERS);

    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
  });

  // Disable before the report so the meter is not moving underneath the billed
  // figure; report before the cancel because a meter event after cancellation
  // lands on no invoice; collect before the delete because collection needs a
  // chargeable customer and the delete removes exactly that.
  it('disables, reports, cancels, collects, then deletes', async () => {
    mockSubscriptionsList.mockResolvedValue({
      data: [{ id: 'sub_1', status: 'active', default_payment_method: 'pm_1' }],
    });
    mockInvoicesList.mockResolvedValue({ data: [{ id: 'in_1' }] });
    mockFinalize.mockResolvedValue({ status: 'open' });

    await tearDownStripe(ORG, MEMBERS);

    expect(order).toEqual(['disable', 'report', 'cancel:sub_1', 'pay', `del:${CUSTOMER}`]);
    expect(mockDisableTenants).toHaveBeenCalledWith(ORG, 'disabled');
    expect(mockReportOrgUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        subscriptionId: 'sub_1',
        stripeCustomerId: CUSTOMER,
        currentPeriodStart: '2026-08-01T00:00:00.000Z',
      }),
    );
  });

  // An unbillable final period must not wedge a teardown, and the re-drive
  // reports the same absolute value anyway.
  it('cancels and deletes even when the final report fails', async () => {
    mockReportOrgUsage.mockRejectedValueOnce(new Error('Aurora 500'));
    mockSubscriptionsList.mockResolvedValue({ data: [{ id: 'sub_1', status: 'active' }] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await tearDownStripe(ORG, MEMBERS);
      expect(mockSubscriptionsCancel).toHaveBeenCalled();
      expect(mockCustomersDel).toHaveBeenCalledWith(CUSTOMER);
    } finally {
      error.mockRestore();
    }
  });

  // The Stripe-triggered flow: the customer is already gone when the worker runs,
  // so every step has to read that as success rather than failing the pass.
  it('completes the pass when the customer is already gone', async () => {
    const missing = Object.assign(new Error('No such customer'), { code: 'resource_missing' });
    mockSubscriptionsList.mockRejectedValue(missing);
    mockCustomersDel.mockRejectedValue(missing);

    await expect(tearDownStripe(ORG, MEMBERS)).resolves.toBeUndefined();
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
  });

  // Production sets the default on the subscription, not the customer, so
  // leaving it implicit fails with a 402 and collects nothing.
  it('pays with the subscription payment method captured before the cancel', async () => {
    mockSubscriptionsList.mockResolvedValue({
      data: [{ id: 'sub_1', status: 'active', default_payment_method: 'pm_sub' }],
    });
    mockInvoicesList.mockResolvedValue({ data: [{ id: 'in_1' }] });
    mockFinalize.mockResolvedValue({ status: 'open' });

    await tearDownStripe(ORG, MEMBERS);

    expect(mockPay).toHaveBeenCalledWith('in_1', { payment_method: 'pm_sub' });
  });

  it('falls back to the customer default, then to any attached method', async () => {
    mockSubscriptionsList.mockResolvedValue({ data: [{ id: 'sub_1', status: 'active' }] });
    mockInvoicesList.mockResolvedValue({ data: [{ id: 'in_1' }] });
    mockFinalize.mockResolvedValue({ status: 'open' });
    mockCustomersRetrieve.mockResolvedValue({
      invoice_settings: { default_payment_method: 'pm_cust' },
    });

    await tearDownStripe(ORG, MEMBERS);
    expect(mockPay).toHaveBeenCalledWith('in_1', { payment_method: 'pm_cust' });

    vi.clearAllMocks();
    mockSubscriptionsList.mockResolvedValue({ data: [{ id: 'sub_1', status: 'active' }] });
    mockInvoicesList.mockResolvedValue({ data: [{ id: 'in_1' }] });
    mockFinalize.mockResolvedValue({ status: 'open' });
    mockCustomersRetrieve.mockResolvedValue({ invoice_settings: {} });
    mockPaymentMethodsList.mockResolvedValue({ data: [{ id: 'pm_any' }] });

    await tearDownStripe(ORG, MEMBERS);
    expect(mockPay).toHaveBeenCalledWith('in_1', { payment_method: 'pm_any' });
  });

  // finalizeInvoice auto-pays when a default card is on file, so paying again
  // would throw.
  it('does not pay an invoice finalize already settled', async () => {
    mockInvoicesList.mockResolvedValue({ data: [{ id: 'in_1' }] });
    mockFinalize.mockResolvedValue({ status: 'paid' });

    await tearDownStripe(ORG, MEMBERS);

    expect(mockPay).not.toHaveBeenCalled();
    expect(mockCustomersDel).toHaveBeenCalled();
  });

  // A declined card must not wedge the teardown; the unpaid invoice survives in
  // `open` for finance to see.
  it('still deletes the customer when collection fails', async () => {
    mockInvoicesList.mockResolvedValue({ data: [{ id: 'in_1' }] });
    mockFinalize.mockRejectedValue(new Error('card_declined'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await tearDownStripe(ORG, MEMBERS);
      expect(mockCustomersDel).toHaveBeenCalledWith(CUSTOMER);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  // Probed: a repeat delete 404s rather than succeeding, so every re-drive after
  // the first lands here.
  it('treats an already-deleted customer as success', async () => {
    mockCustomersDel.mockRejectedValue(
      Object.assign(new Error('No such customer'), {
        code: 'resource_missing',
      }),
    );

    await expect(tearDownStripe(ORG, MEMBERS)).resolves.toBeUndefined();
  });

  it('propagates any other Stripe failure', async () => {
    mockCustomersDel.mockRejectedValue(
      Object.assign(new Error('rate limited'), {
        code: 'rate_limit',
      }),
    );

    await expect(tearDownStripe(ORG, MEMBERS)).rejects.toThrow('rate limited');
  });
});
