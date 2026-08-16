import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';

const mockGetMe = vi.fn();
vi.mock('../lib/api.js', () => ({ getMe: () => mockGetMe() }));

import { RequirePermission } from './RequirePermission';
import { seedPermissions } from '../lib/test-permissions.js';

function renderGate(node: React.ReactNode, seed?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(client);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('RequirePermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Nothing resolves unless a test says so: the gate must not depend on a
    // request completing to stay closed.
    mockGetMe.mockReturnValue(new Promise(() => {}));
  });

  it('renders the children for a role that holds the permission', async () => {
    renderGate(
      <RequirePermission permission="buckets.delete">Delete</RequirePermission>,
      (client) => seedPermissions(client, OrgRole.Admin),
    );

    await waitFor(() => expect(screen.getByText('Delete')).toBeInTheDocument());
  });

  it('renders the fallback for a role that does not', async () => {
    renderGate(
      <RequirePermission permission="buckets.delete" fallback={<span>Ask an admin</span>}>
        Delete
      </RequirePermission>,
      (client) => seedPermissions(client, OrgRole.Member),
    );

    await waitFor(() => expect(screen.getByText('Ask an admin')).toBeInTheDocument());
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('renders nothing at all when no fallback is given', async () => {
    const { container } = renderGate(
      <RequirePermission permission="billing.manage">Manage plan</RequirePermission>,
      (client) => seedPermissions(client, OrgRole.ReadOnly),
    );

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows neither children nor fallback while /me is loading', () => {
    // A destructive control that appears and then vanishes is worse than one
    // that arrives a moment late.
    renderGate(
      <RequirePermission permission="buckets.delete" fallback={<span>Ask an admin</span>}>
        Delete
      </RequirePermission>,
    );

    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    expect(screen.queryByText('Ask an admin')).not.toBeInTheDocument();
  });

  it('renders the pending node when one is given', () => {
    renderGate(
      <RequirePermission permission="buckets.delete" pending={<span>Checking…</span>}>
        Delete
      </RequirePermission>,
    );

    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  it('falls back when /me cannot be read', async () => {
    mockGetMe.mockRejectedValue(new Error('network'));

    renderGate(
      <RequirePermission permission="buckets.delete" fallback={<span>Ask an admin</span>}>
        Delete
      </RequirePermission>,
    );

    await waitFor(() => expect(screen.getByText('Ask an admin')).toBeInTheDocument());
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });
});
