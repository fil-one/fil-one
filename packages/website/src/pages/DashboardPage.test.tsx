import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, PlanId, SubscriptionStatus } from '@filone/shared';
import type { BillingInfo, MeResponse, UsageResponse } from '@filone/shared';

import { seedPermissions } from '../lib/test-permissions.js';
import { queryKeys } from '../lib/query-client.js';

// ---------------------------------------------------------------------------
// Mocks — the network boundary and the router links the page renders
// ---------------------------------------------------------------------------

const mockGetUsage = vi.fn();
const mockGetBilling = vi.fn();
const mockGetActivity = vi.fn();
const mockGetMe = vi.fn();

vi.mock('../lib/api.js', () => ({
  getUsage: (...a: unknown[]) => mockGetUsage(...a),
  getBilling: (...a: unknown[]) => mockGetBilling(...a),
  getActivity: (...a: unknown[]) => mockGetActivity(...a),
  // `usePermissions` reads `/me`; a refetch of the seeded cache would otherwise
  // call undefined and error the query the whole page is gated on.
  getMe: (...a: unknown[]) => mockGetMe(...a),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

import { DashboardPage } from './DashboardPage.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USAGE: UsageResponse = {
  storage: { usedBytes: 1_000 },
  egress: { usedBytes: 500 },
  buckets: { count: 2 },
  objects: { count: 3 },
  accessKeys: { count: 1 },
};

function payAsYouGoBilling(): BillingInfo {
  return {
    subscription: {
      planId: PlanId.PayAsYouGo,
      status: SubscriptionStatus.Active,
      monthlyMinimumCents: 0,
      planName: 'Pay as you go',
      pricePerTbCents: 499,
    },
  };
}

/** An org billed on a price sales quoted: a name, and no single per-TB rate. */
function contractedBilling(): BillingInfo {
  return {
    subscription: {
      planId: PlanId.PayAsYouGo,
      status: SubscriptionStatus.Active,
      planName: 'Business',
      monthlyMinimumCents: 250_000,
    },
  };
}

function renderPage(role: OrgRole = OrgRole.Owner, me: Partial<MeResponse> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role, me);
  const view = render(
    <QueryClientProvider client={client}>
      <DashboardPage />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUsage.mockResolvedValue(USAGE);
  mockGetBilling.mockResolvedValue(payAsYouGoBilling());
  mockGetActivity.mockResolvedValue({ activities: [] });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardPage — the plan panels', () => {
  it('shows the plan card to a role that holds billing.view', async () => {
    renderPage(OrgRole.Owner);

    const status = await screen.findByTestId('subscription-status');
    expect(status).toHaveAttribute('data-status', SubscriptionStatus.Active);
    expect(screen.getByText('Est. monthly cost')).toBeInTheDocument();
  });

  it('names the plan what Stripe calls it', async () => {
    mockGetBilling.mockResolvedValue(contractedBilling());
    renderPage(OrgRole.Owner);

    expect(await screen.findByText('Business')).toBeInTheDocument();
  });

  it('states the rate the org is billed on', async () => {
    renderPage(OrgRole.Owner);

    // 2 TB at $4.99 a TB, from the price the API reported.
    expect(await screen.findByText('Est. monthly cost')).toBeInTheDocument();
    expect(screen.getByText('$4.99/TB per month · no egress fees')).toBeInTheDocument();
  });

  it('names a manually billed plan and says it is billed manually', async () => {
    mockGetBilling.mockResolvedValue({
      subscription: { planId: PlanId.Manual, status: SubscriptionStatus.Manual },
    });
    renderPage(OrgRole.Owner);

    expect(await screen.findByText('Custom plan')).toBeInTheDocument();
    expect(screen.getByText('Billed manually')).toBeInTheDocument();
    expect(screen.queryByText('Est. monthly cost')).not.toBeInTheDocument();
  });

  it('withholds an estimate from an org whose price states no rate', async () => {
    // The card used to multiply by a hardcoded $4.99, so a contracted org was
    // shown an estimate for a rate it does not pay.
    mockGetBilling.mockResolvedValue(contractedBilling());
    renderPage(OrgRole.Owner);

    await screen.findByText('Business');
    expect(screen.queryByText('Est. monthly cost')).not.toBeInTheDocument();
    expect(screen.getByText('Custom pricing · no egress fees')).toBeInTheDocument();
  });

  it('never asks for billing on behalf of a role that cannot read it', async () => {
    renderPage(OrgRole.Member);

    await screen.findByText('STORAGE');
    expect(mockGetBilling).not.toHaveBeenCalled();
    expect(screen.queryByTestId('subscription-status')).not.toBeInTheDocument();
  });

  it('drops the plan panels when the caller loses billing.view mid-session', async () => {
    // Disabling the query does not evict what it already fetched, and the
    // mounted page is a live observer, so the plan card, its badge and the cost
    // estimate would keep rendering the last answer after a demotion.
    const { client } = renderPage(OrgRole.Owner);
    expect(await screen.findByTestId('subscription-status')).toBeInTheDocument();

    // What a /me refetch after a demotion does.
    act(() => seedPermissions(client, OrgRole.Member));

    await waitFor(() =>
      expect(screen.queryByTestId('subscription-status')).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('Est. monthly cost')).not.toBeInTheDocument();
    // The cached response is still there — the read is what changed.
    expect(client.getQueryData(queryKeys.billing)).toBeDefined();
  });
});

describe('DashboardPage — trial banner', () => {
  it('hides the banner on dismiss and moves focus to the page heading', async () => {
    const billing = payAsYouGoBilling();
    mockGetBilling.mockResolvedValue({
      subscription: { ...billing.subscription, status: SubscriptionStatus.Trialing },
    });
    renderPage(OrgRole.Owner);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss trial banner' }));

    expect(screen.queryByRole('button', { name: 'Dismiss trial banner' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Dashboard' }));
  });
});

describe('DashboardPage — bucket buttons', () => {
  // The default activity mock is empty, so for an org with no buckets and no
  // keys the empty activity card renders its button too.
  it.each(['New bucket', 'Create bucket'])(
    'opens the create bucket page from the "%s" button',
    async (name) => {
      mockGetUsage.mockResolvedValue({ ...USAGE, buckets: { count: 0 }, accessKeys: { count: 0 } });
      renderPage();

      expect(await screen.findByRole('link', { name })).toHaveAttribute('href', '/buckets/create');
    },
  );
});

describe('DashboardPage — recent activity', () => {
  it.each([OrgRole.Owner, OrgRole.Admin])(
    'shows %s the feed with a "View all" link to the audit log',
    async (role) => {
      renderPage(role);

      await screen.findByText('Recent Activity');
      const hrefs = screen
        .getAllByRole('link', { name: 'View all' })
        .map((link) => link.getAttribute('href'));
      expect(hrefs).toContain('/audit');
    },
  );

  it.each([OrgRole.Member, OrgRole.ReadOnly])(
    'leaves the feed out for %s, who cannot read the audit log, and never asks for it',
    async (role) => {
      renderPage(role);

      // The usage counters render once the page is past its skeleton.
      await screen.findByRole('heading', { name: 'Dashboard' });
      expect(screen.queryByText('Recent Activity')).not.toBeInTheDocument();
      expect(mockGetActivity).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['buckets', { buckets: { count: 2 }, accessKeys: { count: 0 } }],
    ['only access keys', { buckets: { count: 0 }, accessKeys: { count: 1 } }],
  ])(
    'says there is no recent activity, without a create button, for an org that has %s',
    async (_case, counts) => {
      mockGetUsage.mockResolvedValue({ ...USAGE, ...counts });
      renderPage();

      expect(await screen.findByText('No recent activity')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Create bucket' })).not.toBeInTheDocument();
    },
  );

  it('shows a loading feed rather than an empty one while the activity loads', async () => {
    // Never settles, so the feed stays loading.
    mockGetActivity.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(
      await screen.findByRole('status', { name: 'Loading recent activity' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('No recent activity')).not.toBeInTheDocument();
  });

  it('labels a bucket created outside the console apart from one the console created', async () => {
    mockGetActivity.mockResolvedValue({
      activities: [
        {
          id: 'any-outside',
          resourceType: 'bucket',
          action: 'bucket.created',
          resourceName: 'outside-bucket',
          timestamp: new Date().toISOString(),
          createdOutsideConsole: true,
        },
        {
          id: 'any-console',
          resourceType: 'bucket',
          action: 'bucket.created',
          resourceName: 'console-bucket',
          timestamp: new Date().toISOString(),
        },
      ],
    });
    renderPage();

    expect(await screen.findByText('Created outside the console')).toBeInTheDocument();
    expect(screen.getByText('Created')).toBeInTheDocument();
  });

  it('loads the activity again from "Try again" after a failure', async () => {
    mockGetActivity.mockRejectedValueOnce(new Error('any activity error'));
    mockGetUsage.mockResolvedValue({ ...USAGE, buckets: { count: 1 } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('No recent activity')).toBeInTheDocument();
    expect(mockGetActivity).toHaveBeenCalledTimes(2);
  });

  it('says the activity failed to load rather than that there is none', async () => {
    mockGetActivity.mockRejectedValue(new Error('any activity error'));
    renderPage();

    expect(await screen.findByText('Failed to load recent activity')).toBeInTheDocument();
    expect(screen.queryByText('No recent activity')).not.toBeInTheDocument();
  });
});

describe('DashboardPage — resource counts', () => {
  it.each([
    ['buckets', { buckets: { count: 1_234 } }, '1,234'],
    ['objects', { objects: { count: 342_236 } }, '342,236'],
    ['access keys', { accessKeys: { count: 5_678 } }, '5,678'],
  ])('groups the %s count by thousands', async (_label, counts, expected) => {
    mockGetUsage.mockResolvedValue({ ...USAGE, ...counts });
    renderPage();

    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
});
