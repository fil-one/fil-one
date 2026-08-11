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

/** Only the member-keyed searches, i.e. the fallback path's calls. */
function memberSearchInputs() {
  return searchInputs().filter((i) => String(i.query).includes("metadata['userId']"));
}

/**
 * Route hits by which key is searched. Discovery tries `metadata['orgId']` first and
 * only falls back to the per-member `metadata['userId']` searches when that is empty,
 * so a test about the fallback has to leave the org-id search unproductive.
 */
function routeSearch(opts: {
  byOrg?: { id: string; metadata?: Record<string, string> }[];
  byMember?: (userId: string) => { id: string; metadata?: Record<string, string> }[];
}) {
  mockCustomersSearch.mockImplementation(({ query }: { query: string }) => {
    if (query.includes("metadata['orgId']")) return stripeSearch(opts.byOrg ?? []);
    const userId = /metadata\['userId'\]:'([^']*)'/.exec(query)?.[1] ?? '';
    return stripeSearch(opts.byMember ? opts.byMember(userId) : []);
  });
}

describe('discoverBillingCustomer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCustomersSearch.mockReturnValue(stripeSearch([]));
  });

  it('finds the customer by org id without searching any member', async () => {
    routeSearch({ byOrg: [{ id: 'cus_org', metadata: { orgId: ORG_ID } }] });

    const result = await discoverBillingCustomer(ORG_ID, [
      { userId: 'user-1' },
      { userId: 'user-2' },
    ]);

    expect(result).toEqual({ customerId: 'cus_org', extraCustomerIds: [] });
    expect(searchInputs()).toEqual([{ query: "metadata['orgId']:'org-1'", limit: 100 }]);
    expect(memberSearchInputs()).toEqual([]);
  });

  it('falls back to the member search and warns when the org id search is empty', async () => {
    // The one remaining hole: an org whose customer the usage worker never syncs
    // (no active subscription, so the orchestrator never dispatches it) is never
    // backfilled. This warn is what says the fallback is still load-bearing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    routeSearch({ byOrg: [], byMember: () => [{ id: 'cus_legacy' }] });

    const result = await discoverBillingCustomer(ORG_ID, [{ userId: 'user-1' }]);

    expect(result).toEqual({ customerId: 'cus_legacy', extraCustomerIds: [] });
    expect(memberSearchInputs()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('never backfilled by the usage worker'),
      expect.objectContaining({ orgId: ORG_ID, customerIds: ['cus_legacy'] }),
    );
    warn.mockRestore();
  });

  it('searches Stripe metadata once per member with an exact userId query', async () => {
    mockCustomersSearch.mockReturnValue(stripeSearch([]));

    await discoverBillingCustomer(ORG_ID, [{ userId: 'user-1' }, { userId: 'user_2' }]);

    expect(memberSearchInputs()).toEqual([
      { query: "metadata['userId']:'user-1'", limit: 100 },
      { query: "metadata['userId']:'user_2'", limit: 100 },
    ]);
  });

  it('returns nothing for zero hits, and never searches for an empty member list', async () => {
    expect(await discoverBillingCustomer(ORG_ID, [])).toEqual({
      customerId: undefined,
      extraCustomerIds: [],
    });
    // The org-id search still runs; only the per-member loop has nothing to do.
    expect(memberSearchInputs()).toEqual([]);

    expect(await discoverBillingCustomer(ORG_ID, [{ userId: 'user-1' }])).toEqual({
      customerId: undefined,
      extraCustomerIds: [],
    });
  });

  it('dedupes the same customer across members', async () => {
    routeSearch({ byMember: () => [{ id: 'cus_1', metadata: { orgId: ORG_ID } }] });

    const result = await discoverBillingCustomer(ORG_ID, [
      { userId: 'user-1' },
      { userId: 'user-2' },
    ]);

    expect(memberSearchInputs()).toHaveLength(2);
    expect(result).toEqual({ customerId: 'cus_1', extraCustomerIds: [] });
  });

  it('reports the first distinct customer and surfaces the rest as extras (invariant violation)', async () => {
    routeSearch({
      byMember: (userId) =>
        userId === 'user-1'
          ? [{ id: 'cus_1', metadata: { orgId: ORG_ID } }]
          : [
              { id: 'cus_1', metadata: { orgId: ORG_ID } },
              { id: 'cus_2', metadata: { orgId: ORG_ID } },
            ],
    });

    expect(
      await discoverBillingCustomer(ORG_ID, [{ userId: 'user-1' }, { userId: 'user-2' }]),
    ).toEqual({ customerId: 'cus_1', extraCustomerIds: ['cus_2'] });
  });

  it('never claims a customer whose metadata names another org', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    routeSearch({
      byMember: () => [
        { id: 'cus_foreign', metadata: { orgId: 'org-other' } },
        { id: 'cus_ours', metadata: { orgId: ORG_ID } },
      ],
    });

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
    routeSearch({ byMember: () => [{ id: 'cus_legacy' }] });

    expect(await discoverBillingCustomer(ORG_ID, [{ userId: 'user-1' }])).toEqual({
      customerId: 'cus_legacy',
      extraCustomerIds: [],
    });
  });

  it('fails the whole pass on an unsearchable userId rather than skipping that member', async () => {
    // Skipping was worse than failing: that member's customer would never be
    // found, never cancelled and never redacted, and the teardown would still
    // report success. Throwing keeps the record non-DONE for the re-drive.
    routeSearch({ byMember: () => [{ id: 'cus_1', metadata: { orgId: ORG_ID } }] });

    await expect(
      discoverBillingCustomer(ORG_ID, [
        { userId: "user-1' OR metadata['orgId']:'*" },
        { userId: 'user-2' },
      ]),
    ).rejects.toThrow(/cannot be searched in Stripe/);

    // The injection attempt never reaches Stripe; only the org-id search ran.
    expect(memberSearchInputs()).toEqual([]);
  });

  it('rejects the whole call when a search fails — there is no snapshot to fall back to', async () => {
    mockCustomersSearch.mockImplementation(({ query }: { query: string }) => {
      if (query.includes('user-2')) throw new Error('stripe search is down');
      // The org-id search must come back empty, or the fallback never runs.
      return stripeSearch([]);
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
