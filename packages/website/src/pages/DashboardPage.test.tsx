import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole, PlanId, SubscriptionStatus } from '@filone/shared';
import type { BillingInfo, UsageResponse } from '@filone/shared';

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
    },
  };
}

function renderPage(role = OrgRole.Owner) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
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
