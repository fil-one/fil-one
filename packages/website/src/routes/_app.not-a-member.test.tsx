import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse, OrgMembershipSummary } from '@filone/shared';
import { OrgRole } from '@filone/shared';

const { switchToOrg, permissions, location } = vi.hoisted(() => ({
  switchToOrg: vi.fn(),
  permissions: { isNotAMember: true, billingActive: true },
  location: { pathname: '/dashboard' },
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: { location: typeof location }) => unknown }) =>
    select({ location }),
  Outlet: () => <div data-testid="page" />,
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
}));
vi.mock('./__root', () => ({ Route: {} }));
vi.mock('../components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shell">{children}</div>
  ),
}));
vi.mock('../components/BillingRequiredGate.js', () => ({
  BillingRequiredGate: () => <div data-testid="billing-gate" />,
}));
vi.mock('../lib/use-permissions.js', () => ({
  usePermissions: () => permissions,
}));
vi.mock('../lib/step-up.js', () => ({ consumePendingMfaAction: () => null }));
vi.mock('../lib/api.js', () => ({ getMe: vi.fn(), logout: vi.fn() }));
vi.mock('../lib/active-org.js', () => ({ switchToOrg, onSwitchingOrgChange: () => () => {} }));

import { billingGateCovers, Route } from './_app';
import { queryKeys } from '../lib/query-client.js';

function account(memberships: OrgMembershipSummary[]): MeResponse {
  return { orgId: 'org-1', orgName: 'Acme', memberships } as unknown as MeResponse;
}

function renderNotAMember(me: MeResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.me, me);
  const Component = Route.options.component as React.ComponentType;
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}

describe('the not-a-member screen', () => {
  beforeEach(() => {
    switchToOrg.mockReset();
    permissions.isNotAMember = true;
  });

  // Rendered without the shell, so its org switcher is not there to reach for.
  it('offers another org the account still belongs to', () => {
    renderNotAMember(
      account([
        { orgId: 'org-1', orgName: 'Acme', role: OrgRole.Member },
        { orgId: 'org-2', orgName: 'Globex', role: OrgRole.Owner },
      ]),
    );

    expect(screen.getByTestId('not-a-member')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Globex' }));
    expect(switchToOrg).toHaveBeenCalledWith('org-2');
  });

  it('offers only refresh and log out when there is nowhere else to go', () => {
    renderNotAMember(account([{ orgId: 'org-1', orgName: 'Acme', role: OrgRole.Member }]));

    expect(screen.queryByRole('button', { name: /^Go to/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
  });
});

// A `/me` refetch (the last membership removed, or a self-leave) lands on the
// floor org without rerunning `beforeLoad`, so the layout redirects too.
describe('the layout after /me lands on an unnamed only org', () => {
  beforeEach(() => {
    permissions.isNotAMember = false;
  });

  it.each([
    [true, '/left-organization'],
    [false, '/create-organization'],
  ])('with floorOrg %s, sends the caller to %s', (floorOrg, target) => {
    renderNotAMember({
      ...account([{ orgId: 'org-1', orgName: 'Acme', role: OrgRole.Owner }]),
      nameConfirmed: false,
      floorOrg,
    });

    expect(screen.getByTestId('navigate')).toHaveTextContent(target);
    expect(screen.queryByTestId('shell')).not.toBeInTheDocument();
  });
});

// With no active plan the gate stands in for the org's pages, except the ones
// where the org can still be left or deleted.
describe('the billing gate', () => {
  function renderAt(pathname: string, billingActive: boolean) {
    permissions.isNotAMember = false;
    permissions.billingActive = billingActive;
    location.pathname = pathname;
    renderNotAMember(account([{ orgId: 'org-1', orgName: 'Acme', role: OrgRole.Owner }]));
  }

  it('lets every page through for an org with a plan', () => {
    renderAt('/buckets', true);

    expect(screen.getByTestId('page')).toBeInTheDocument();
  });

  it('stands in for a page for an org without one', () => {
    renderAt('/buckets', false);

    expect(screen.getByTestId('billing-gate')).toBeInTheDocument();
    expect(screen.queryByTestId('page')).not.toBeInTheDocument();
  });

  // Settings holds Leave organization, Edit organization the danger zone.
  it.each(['/settings', '/edit-organization', '/support'])(
    'still opens %s, where the org can be left or deleted',
    (pathname) => {
      renderAt(pathname, false);

      expect(screen.getByTestId('page')).toBeInTheDocument();
      expect(screen.queryByTestId('billing-gate')).not.toBeInTheDocument();
    },
  );
});

describe('billingGateCovers', () => {
  it('covers every page but the ones past the gate', () => {
    expect(billingGateCovers('/dashboard')).toBe(true);
    expect(billingGateCovers('/members')).toBe(true);
    expect(billingGateCovers('/settings')).toBe(false);
    expect(billingGateCovers('/settings/')).toBe(false);
  });
});
