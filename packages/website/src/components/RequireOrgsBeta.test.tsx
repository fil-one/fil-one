import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';

import { RequireOrgsBeta } from './RequireOrgsBeta';
import { seedPermissions } from '../lib/test-permissions.js';

vi.mock('@tanstack/react-router', () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
}));
vi.mock('../lib/api.js', () => ({ getMe: vi.fn() }));

function renderGate(orgsBeta: boolean) {
  const client = new QueryClient();
  seedPermissions(client, OrgRole.Owner, { orgsBeta });
  render(
    <QueryClientProvider client={client}>
      <RequireOrgsBeta>beta page</RequireOrgsBeta>
    </QueryClientProvider>,
  );
}

describe('RequireOrgsBeta', () => {
  it('renders the page in the beta', () => {
    renderGate(true);
    expect(screen.getByText('beta page')).toBeInTheDocument();
  });

  it('sends a caller outside the beta to the dashboard', () => {
    renderGate(false);
    expect(screen.queryByText('beta page')).not.toBeInTheDocument();
    expect(screen.getByTestId('navigate')).toHaveTextContent('/dashboard');
  });
});
