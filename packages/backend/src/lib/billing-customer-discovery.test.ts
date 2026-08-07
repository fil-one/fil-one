import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCustomersSearch = vi.fn();
vi.mock('./stripe-client.js', () => ({
  getStripeClient: () => ({
    customers: { search: (...args: unknown[]) => mockCustomersSearch(...args) },
  }),
}));

import { discoverBillingCustomer } from './billing-customer-discovery.js';

/** Stripe's auto-paginating search result, as the SDK returns it to `for await`. */
function stripeSearch(hits: { id: string; metadata?: Record<string, string> }[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* hits;
    },
  };
}

const ORG_ID = 'org-1';

/** The search calls made, as `{query, limit}` inputs. */
function searchInputs() {
  return mockCustomersSearch.mock.calls.map(([input]) => input as Record<string, unknown>);
}

describe('discoverBillingCustomer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCustomersSearch.mockReturnValue(stripeSearch([]));
  });

  it('searches Stripe metadata once per member with an exact userId query', async () => {
    mockCustomersSearch.mockReturnValue(stripeSearch([]));

    await discoverBillingCustomer(ORG_ID, [{ userId: 'user-1' }, { userId: 'user_2' }]);

    expect(searchInputs()).toEqual([
      { query: "metadata['userId']:'user-1'", limit: 100 },
      { query: "metadata['userId']:'user_2'", limit: 100 },
    ]);
  });

  it('returns nothing for zero hits, and never searches for an empty member list', async () => {
    expect(await discoverBillingCustomer(ORG_ID, [])).toEqual({
      customerId: undefined,
      extraCustomerIds: [],
    });
    expect(mockCustomersSearch).not.toHaveBeenCalled();

    expect(await discoverBillingCustomer(ORG_ID, [{ userId: 'user-1' }])).toEqual({
      customerId: undefined,
      extraCustomerIds: [],
    });
  });

  it('dedupes the same customer across members', async () => {
    mockCustomersSearch.mockReturnValue(
      stripeSearch([{ id: 'cus_1', metadata: { orgId: ORG_ID } }]),
    );

    const result = await discoverBillingCustomer(ORG_ID, [
      { userId: 'user-1' },
      { userId: 'user-2' },
    ]);

    expect(mockCustomersSearch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ customerId: 'cus_1', extraCustomerIds: [] });
  });

  it('reports the first distinct customer and surfaces the rest as extras (invariant violation)', async () => {
    mockCustomersSearch
      .mockReturnValueOnce(stripeSearch([{ id: 'cus_1', metadata: { orgId: ORG_ID } }]))
      .mockReturnValueOnce(
        stripeSearch([
          { id: 'cus_1', metadata: { orgId: ORG_ID } },
          { id: 'cus_2', metadata: { orgId: ORG_ID } },
        ]),
      );

    expect(
      await discoverBillingCustomer(ORG_ID, [{ userId: 'user-1' }, { userId: 'user-2' }]),
    ).toEqual({ customerId: 'cus_1', extraCustomerIds: ['cus_2'] });
  });

  it('never claims a customer whose metadata names another org', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockCustomersSearch.mockReturnValue(
      stripeSearch([
        { id: 'cus_foreign', metadata: { orgId: 'org-other' } },
        { id: 'cus_ours', metadata: { orgId: ORG_ID } },
      ]),
    );

    expect(await discoverBillingCustomer(ORG_ID, [{ userId: 'user-1' }])).toEqual({
      customerId: 'cus_ours',
      extraCustomerIds: [],
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('owned by another org'),
      expect.objectContaining({ customerId: 'cus_foreign', customerOrgId: 'org-other' }),
    );
    warn.mockRestore();
  });

  it('accepts a hit with no orgId metadata (legacy customers predate the stamp)', async () => {
    mockCustomersSearch.mockReturnValue(stripeSearch([{ id: 'cus_legacy' }]));

    expect(await discoverBillingCustomer(ORG_ID, [{ userId: 'user-1' }])).toEqual({
      customerId: 'cus_legacy',
      extraCustomerIds: [],
    });
  });

  it('rejects rather than escapes an unsearchable userId, and still searches the other members', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockCustomersSearch.mockReturnValue(
      stripeSearch([{ id: 'cus_1', metadata: { orgId: ORG_ID } }]),
    );

    const result = await discoverBillingCustomer(ORG_ID, [
      { userId: "user-1' OR metadata['orgId']:'*" },
      { userId: 'user-2' },
    ]);

    // The injection attempt never reaches Stripe...
    expect(searchInputs()).toEqual([{ query: "metadata['userId']:'user-2'", limit: 100 }]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unsearchable userId'),
      expect.objectContaining({ orgId: ORG_ID }),
    );
    // ...and the well-formed member is still swept.
    expect(result).toEqual({ customerId: 'cus_1', extraCustomerIds: [] });
    warn.mockRestore();
  });

  it('rejects the whole call when a search fails — there is no snapshot to fall back to', async () => {
    mockCustomersSearch.mockImplementation(({ query }: { query: string }) => {
      if (query.includes('user-2')) throw new Error('stripe search is down');
      return stripeSearch([{ id: 'cus_1', metadata: { orgId: ORG_ID } }]);
    });

    await expect(
      discoverBillingCustomer(ORG_ID, [{ userId: 'user-1' }, { userId: 'user-2' }]),
    ).rejects.toThrow(/Stripe customer search failed for org org-1 \(member user-2\)/);
  });

  it('rejects when the search iterator fails mid-page', async () => {
    mockCustomersSearch.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { id: 'cus_1', metadata: { orgId: ORG_ID } };
        throw new Error('page 2 blew up');
      },
    });

    await expect(discoverBillingCustomer(ORG_ID, [{ userId: 'user-1' }])).rejects.toThrow(
      /Stripe customer search failed/,
    );
  });
});
