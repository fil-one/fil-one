import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse, OrgMembershipSummary } from '@filone/shared';
import { OrgRole } from '@filone/shared';

const { switchToOrg, permissions } = vi.hoisted(() => ({
  switchToOrg: vi.fn(),
  permissions: { isNotAMember: true },
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  Outlet: () => <div data-testid="page" />,
}));
vi.mock('./__root', () => ({ Route: {} }));
vi.mock('../components/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shell">{children}</div>
  ),
}));
vi.mock('../lib/use-permissions.js', () => ({
  usePermissions: () => permissions,
}));
vi.mock('../lib/step-up.js', () => ({ consumePendingMfaAction: () => null }));
vi.mock('../lib/api.js', () => ({ getMe: vi.fn(), logout: vi.fn() }));
vi.mock('../lib/active-org.js', () => ({ switchToOrg, onSwitchingOrgChange: () => () => {} }));

import { Route } from './_app';
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
