import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import { ApiErrorCode, SubscriptionStatus } from '@filone/shared';
import type { SubscriptionRecord } from './dynamo-records.ts';
import { createOrUpdateSubscription } from './reactivate-subscription.ts';

const mockSubscriptionsRetrieve = vi.fn();
const mockSubscriptionsUpdate = vi.fn();
const mockSubscriptionsCreate = vi.fn();
const mockSubscriptionsList = vi.fn();
const mockInvoicesList = vi.fn();
const mockInvoicesFinalize = vi.fn();
const mockInvoicesPay = vi.fn();

// The fake implements only the calls reactivation makes; the rest of the client
// is never reached.
const stripe = {
  subscriptions: {
    retrieve: mockSubscriptionsRetrieve,
    update: mockSubscriptionsUpdate,
    create: mockSubscriptionsCreate,
    list: mockSubscriptionsList,
  },
  invoices: {
    list: mockInvoicesList,
    finalizeInvoice: mockInvoicesFinalize,
    pay: mockInvoicesPay,
  },
} as unknown as Stripe;

function buildRecord(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    pk: 'ORG#any-org',
    sk: 'SUBSCRIPTION',
    orgId: 'any-org',
    userId: 'any-user',
    stripeCustomerId: 'cus_any',
    subscriptionId: 'sub_named',
    subscriptionStatus: SubscriptionStatus.GracePeriod,
    ...overrides,
  } as SubscriptionRecord;
}

function stripeSubscription(id: string, status: string) {
  return { id, status, customer: 'cus_any', items: { data: [] } };
}

function reactivate(record: SubscriptionRecord, promotionCodeId?: string) {
  return createOrUpdateSubscription({
    stripe,
    record,
    paymentMethodId: 'pm_new',
    priceId: 'price_any',
    userId: 'any-user',
    orgId: 'any-org',
    promotionCodeId,
  });
}

/** Every Stripe call that changes state, as `method:target`, in call order. */
function writes(): string[] {
  const calls: [string, ReturnType<typeof vi.fn>][] = [
    ['update', mockSubscriptionsUpdate],
    ['create', mockSubscriptionsCreate],
    ['finalize', mockInvoicesFinalize],
    ['pay', mockInvoicesPay],
  ];
  return calls
    .flatMap(([name, fn]) =>
      fn.mock.calls.map((args, i) => ({
        order: fn.mock.invocationCallOrder[i],
        label: `${name}:${typeof args[0] === 'string' ? args[0] : 'new'}`,
      })),
    )
    .sort((a, b) => a.order - b.order)
    .map(({ label }) => label);
}

describe('createOrUpdateSubscription', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSubscriptionsUpdate.mockImplementation(async (id: string) =>
      stripeSubscription(id, 'active'),
    );
    mockSubscriptionsCreate.mockResolvedValue(stripeSubscription('sub_created', 'active'));
    mockSubscriptionsList.mockResolvedValue({ data: [] });
    mockInvoicesList.mockResolvedValue({ data: [] });
  });

  it('ends the trial on the named subscription when Stripe reports it trialing', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription('sub_named', 'trialing'));

    const result = await reactivate(buildRecord());

    expect(result).toMatchObject({ ok: true, value: { id: 'sub_named' } });
    expect(mockSubscriptionsUpdate.mock.calls).toStrictEqual([
      ['sub_named', { default_payment_method: 'pm_new' }],
      ['sub_named', { trial_end: 'now', expand: expect.any(Array) }],
    ]);
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('only sets the payment method when Stripe reports the named subscription active', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription('sub_named', 'active'));

    const result = await reactivate(buildRecord());

    expect(result).toMatchObject({ ok: true, value: { id: 'sub_named' } });
    expect(mockSubscriptionsUpdate.mock.calls).toStrictEqual([
      ['sub_named', { default_payment_method: 'pm_new', expand: expect.any(Array) }],
    ]);
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('pays the open invoices of the named subscription with the new card when it is past due', async () => {
    mockSubscriptionsRetrieve
      .mockResolvedValueOnce(stripeSubscription('sub_named', 'past_due'))
      .mockResolvedValueOnce(stripeSubscription('sub_named', 'active'));
    mockInvoicesList.mockImplementation(async ({ status }: { status: string }) => ({
      data: status === 'open' ? [{ id: 'in_open_1' }, { id: 'in_open_2' }] : [],
    }));

    const result = await reactivate(buildRecord());

    expect(result).toMatchObject({ ok: true, value: { id: 'sub_named', status: 'active' } });
    expect(writes()).toStrictEqual(['update:sub_named', 'pay:in_open_1', 'pay:in_open_2']);
    expect(mockInvoicesPay).toHaveBeenCalledWith('in_open_1', { payment_method: 'pm_new' });
    expect(mockInvoicesList).toHaveBeenCalledWith({ subscription: 'sub_named', status: 'open' });
  });

  it('finalizes the draft invoices before paying when the named subscription is unpaid', async () => {
    mockSubscriptionsRetrieve
      .mockResolvedValueOnce(stripeSubscription('sub_named', 'unpaid'))
      .mockResolvedValueOnce(stripeSubscription('sub_named', 'active'));
    mockInvoicesList.mockImplementation(async ({ status }: { status: string }) => ({
      data: status === 'draft' ? [{ id: 'in_draft' }] : [{ id: 'in_open' }],
    }));

    await reactivate(buildRecord());

    expect(writes()).toStrictEqual(['update:sub_named', 'finalize:in_draft', 'pay:in_open']);
    expect(mockInvoicesFinalize).toHaveBeenCalledWith('in_draft', { auto_advance: true });
  });

  it('returns the still-past-due subscription when the new card is declined', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription('sub_named', 'past_due'));
    mockInvoicesList.mockResolvedValue({ data: [{ id: 'in_open' }] });
    mockInvoicesPay.mockRejectedValue(
      Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError' }),
    );

    const result = await reactivate(buildRecord());

    expect(result).toMatchObject({ ok: true, value: { id: 'sub_named', status: 'past_due' } });
  });

  it.each(['canceled', 'incomplete_expired'])(
    'creates a new subscription when Stripe reports the named one %s',
    async (status) => {
      mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription('sub_named', status));

      const result = await reactivate(buildRecord());

      expect(result).toMatchObject({ ok: true, value: { id: 'sub_created' } });
      expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
        {
          customer: 'cus_any',
          items: [{ price: 'price_any' }],
          default_payment_method: 'pm_new',
          metadata: { userId: 'any-user', orgId: 'any-org' },
          expand: expect.any(Array),
        },
        { idempotencyKey: 'activate-org-any-org-sub_named-pm_new' },
      );
      expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    },
  );

  it('creates a new subscription when Stripe no longer has the named one', async () => {
    mockSubscriptionsRetrieve.mockRejectedValue(
      Object.assign(new Error('No such subscription'), { code: 'resource_missing' }),
    );

    const result = await reactivate(buildRecord());

    expect(result).toMatchObject({ ok: true, value: { id: 'sub_created' } });
  });

  it('creates a new subscription without asking Stripe when the row names none', async () => {
    const result = await reactivate(buildRecord({ subscriptionId: undefined }));

    expect(result).toMatchObject({ ok: true, value: { id: 'sub_created' } });
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(expect.any(Object), {
      idempotencyKey: 'activate-org-any-org-none-pm_new',
    });
  });

  it('refuses with 409 and creates nothing when the customer has another live subscription', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue(stripeSubscription('sub_named', 'canceled'));
    mockSubscriptionsList.mockResolvedValue({
      data: [
        stripeSubscription('sub_named', 'canceled'),
        stripeSubscription('sub_stray', 'paused'),
      ],
    });

    const result = await reactivate(buildRecord());

    expect(result).toMatchObject({
      ok: false,
      refusal: { statusCode: 409 },
    });
    expect(JSON.parse((result as { refusal: { body: string } }).refusal.body)).toMatchObject({
      code: ApiErrorCode.SUBSCRIPTION_CONFLICT,
    });
    expect(mockSubscriptionsList).toHaveBeenCalledWith({
      customer: 'cus_any',
      status: 'all',
      limit: 100,
    });
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it.each(['incomplete', 'incomplete_expired', 'canceled'])(
    'creates a new subscription when the only other subscription is %s',
    async (status) => {
      mockSubscriptionsList.mockResolvedValue({ data: [stripeSubscription('sub_other', status)] });

      const result = await reactivate(buildRecord({ subscriptionId: undefined }));

      expect(result).toMatchObject({ ok: true, value: { id: 'sub_created' } });
    },
  );

  it('applies the discount on its own update before the payment when the subscription is past due', async () => {
    mockSubscriptionsRetrieve
      .mockResolvedValueOnce(stripeSubscription('sub_named', 'past_due'))
      .mockResolvedValueOnce(stripeSubscription('sub_named', 'active'));
    mockInvoicesList.mockImplementation(async ({ status }: { status: string }) => ({
      data: status === 'open' ? [{ id: 'in_open' }] : [],
    }));

    await reactivate(buildRecord(), 'promo_any');

    expect(writes()).toStrictEqual(['update:sub_named', 'update:sub_named', 'pay:in_open']);
    expect(mockSubscriptionsUpdate).toHaveBeenNthCalledWith(2, 'sub_named', {
      discounts: [{ promotion_code: 'promo_any' }],
    });
  });

  it('includes the discount and keys the create by it when one is given', async () => {
    await reactivate(buildRecord({ subscriptionId: undefined }), 'promo_any');

    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ discounts: [{ promotion_code: 'promo_any' }] }),
      { idempotencyKey: 'activate-org-any-org-none-pm_new-promo_any' },
    );
  });
});
