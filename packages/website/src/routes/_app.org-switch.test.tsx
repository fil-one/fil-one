import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

// `switchToOrg` imports the router lazily; hand it the one this test renders.
const holder = vi.hoisted(() => ({ router: undefined as unknown }));
vi.mock('../router.js', () => ({
  get router() {
    return holder.router;
  },
}));
vi.mock('../plausible.js', () => ({ track: vi.fn() }));
vi.mock('../components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../components/BillingRequiredGate.js', () => ({
  BillingRequiredGate: () => <div data-testid="billing-gate" />,
}));

import { Route as rootRoute } from './__root';
import { Route as appRoute } from './_app';
import { queryClient, queryKeys } from '../lib/query-client.js';
import { getMe } from '../lib/api.js';
import { isSwitchingOrg, setActiveOrgId, switchToOrg } from '../lib/active-org.js';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const unpaid = new Set<string>();

function meFor(orgId: string) {
  return {
    orgId,
    orgName: orgId === ORG_A ? 'Acme' : 'Globex',
    nameConfirmed: true,
    emailVerified: true,
    billingActive: !unpaid.has(orgId),
    role: 'owner',
    permissions: [],
    memberships: [
      { orgId: ORG_A, orgName: 'Acme', role: 'owner' },
      { orgId: ORG_B, orgName: 'Globex', role: 'owner' },
    ],
  };
}

function renderApp() {
  const dashboardRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/dashboard',
    component: function Dashboard() {
      const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: () => getMe() });
      return <div data-testid="dashboard">{me?.orgName}</div>;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([appRoute.addChildren([dashboardRoute])]),
    history: createMemoryHistory({ initialEntries: ['/dashboard'] }),
  });
  holder.router = router;
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('switching orgs from the dashboard', () => {
  beforeEach(() => {
    document.cookie = 'hs_logged_in=1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        const orgId = new Headers(init?.headers).get('X-Org-Id') ?? ORG_A;
        const body = url.includes('/me') ? meFor(orgId) : {};
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => {
    queryClient.clear();
    sessionStorage.clear();
    unpaid.clear();
    vi.unstubAllGlobals();
    document.cookie = 'hs_logged_in=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });

  // The tab is already on /dashboard, so the switch's navigation does not move it.
  it('shows the org it lands in', async () => {
    setActiveOrgId(ORG_B);
    renderApp();
    expect(await screen.findByText('Globex')).toBeInTheDocument();

    switchToOrg(ORG_A);
    await vi.waitFor(() => expect(isSwitchingOrg()).toBe(false));
    expect(queryClient.getQueryData(queryKeys.me)).toMatchObject({ orgId: ORG_A });

    expect(await screen.findByText('Acme')).toBeInTheDocument();
  });

  it('drops the billing gate once the org it lands in has a plan', async () => {
    unpaid.add(ORG_B);
    setActiveOrgId(ORG_B);
    renderApp();
    expect(await screen.findByTestId('billing-gate')).toBeInTheDocument();

    switchToOrg(ORG_A);
    await vi.waitFor(() => expect(isSwitchingOrg()).toBe(false));
    expect(queryClient.getQueryData(queryKeys.me)).toMatchObject({ orgId: ORG_A });

    expect(await screen.findByTestId('dashboard')).toHaveTextContent('Acme');
    expect(screen.queryByTestId('billing-gate')).not.toBeInTheDocument();
  });
});
