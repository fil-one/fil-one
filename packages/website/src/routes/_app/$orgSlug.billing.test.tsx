import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

// The route's parent resolves `$orgSlug` and renders the whole app shell; the
// gate under test does not need it, and importing it would drag the router in.
vi.mock('./$orgSlug', () => ({ Route: {} }));

// The page itself is covered by BillingPage.test.tsx. Here it only has to be
// distinguishable from the redirect.
vi.mock('../../pages/BillingPage', () => ({
  BillingPage: () => <div data-testid="billing-page" />,
}));

// `Navigate` renders nothing and navigates, which is the whole thing being
// asserted — so it reports where it was sent instead.
vi.mock('@tanstack/react-router', () => ({
  Navigate: ({
    to,
    params,
    search,
  }: {
    to: string;
    params?: Record<string, unknown>;
    search?: Record<string, unknown>;
  }) => (
    <div
      data-testid="navigate"
      data-to={to}
      data-params={JSON.stringify(params ?? {})}
      data-search={JSON.stringify(search ?? {})}
    />
  ),
  createRoute: (options: unknown) => ({ options }),
}));

vi.mock('../../lib/api.js', () => ({ getMe: vi.fn() }));

import { BillingGate } from './$orgSlug.billing';
import { seedPermissions } from '../../lib/test-permissions.js';

const SOLO = [{ orgId: 'org-1', orgName: 'Acme', slug: 'acme', role: OrgRole.Owner }];
const TWO_ORGS = [
  { orgId: 'org-1', orgName: 'Acme', slug: 'acme', role: OrgRole.Owner },
  { orgId: 'org-2', orgName: 'Globex', slug: 'globex', role: OrgRole.Member },
];

function renderGate(overrides: Partial<MeResponse>, portalReturn?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner, overrides);
  return render(
    <QueryClientProvider client={client}>
      <BillingGate portalReturn={portalReturn} orgSlug="acme" />
    </QueryClientProvider>,
  );
}

/** Where the redirect said to go, as `to`/`params` plus its search params. */
function destination() {
  const nav = screen.getByTestId('navigate');
  return {
    to: nav.getAttribute('data-to'),
    params: JSON.parse(nav.getAttribute('data-params') ?? '{}'),
    search: JSON.parse(nav.getAttribute('data-search') ?? '{}'),
  };
}

describe('the /billing route', () => {
  // The bug this gate exists for. A solo org outside the beta has no members
  // surface, so `/organization` answers "inviting teammates is not enabled" and
  // nothing else — redirecting there took plan, payment, invoices and the
  // Stripe portal away from the owners who had no other route to them.
  it('renders the page for a solo org outside the beta', () => {
    renderGate({ memberships: SOLO, orgsBeta: false });

    expect(screen.getByTestId('billing-page')).toBeTruthy();
    expect(screen.queryByTestId('navigate')).toBeNull();
  });

  it('redirects to the Organization page’s Billing tab for an org in the beta', () => {
    renderGate({ memberships: SOLO, orgsBeta: true });

    expect(destination()).toEqual({
      to: '/$orgSlug/organization',
      params: { orgSlug: 'acme' },
      search: { tab: 'billing' },
    });
    expect(screen.queryByTestId('billing-page')).toBeNull();
  });

  it('redirects for a caller in more than one org, beta or not', () => {
    renderGate({ memberships: TWO_ORGS, orgsBeta: false });

    expect(destination().to).toBe('/$orgSlug/organization');
  });

  // Stripe's portal returns to `/billing?portal_return=true`, and `use-billing`
  // reads that to refetch the plan and the card. Dropping it on the way to the
  // tab left a caller looking at the subscription they had just changed.
  it('carries Stripe’s portal_return through the redirect', () => {
    renderGate({ memberships: SOLO, orgsBeta: true }, 'true');

    expect(destination().search).toEqual({ tab: 'billing', portal_return: 'true' });
  });

  it('renders the heading and nothing else while /me is in flight', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <BillingGate orgSlug="acme" />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Billing' })).toBeTruthy();
    expect(screen.queryByTestId('billing-page')).toBeNull();
    expect(screen.queryByTestId('navigate')).toBeNull();
  });

  // A failed `/me` is not an answer about this org's shape. Moving the caller
  // on it would land them at a URL they did not ask for, where the same failed
  // read shows them nothing; the page stays put and fails quiet inside its own
  // permission gate.
  it('stays on the page rather than redirecting when /me fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { getMe } = await import('../../lib/api.js');
    vi.mocked(getMe).mockRejectedValue(new Error('network'));

    render(
      <QueryClientProvider client={client}>
        <BillingGate orgSlug="acme" />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('billing-page')).toBeTruthy();
    expect(screen.queryByTestId('navigate')).toBeNull();
  });
});
