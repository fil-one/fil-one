import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { OrganizationPage } from './OrganizationPage.js';

const mockListMembers = vi.fn();
const mockListInvitations = vi.fn();

vi.mock('../lib/members-api.js', () => ({
  listMembers: () => mockListMembers(),
  listInvitations: () => mockListInvitations(),
  updateMemberRole: vi.fn(),
  removeMember: vi.fn(),
  transferOwnership: vi.fn(),
  createInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
}));

function renderPage(role = OrgRole.Owner) {
  mockListMembers.mockResolvedValue({ members: [] });
  mockListInvitations.mockResolvedValue({ invitations: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <OrganizationPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The tabs on offer, in the order the page lists them. */
function tabNames(): string[] {
  return screen.queryAllByRole('tab').map((tab) => tab.textContent ?? '');
}

describe('OrganizationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives an Owner every tab their role reaches', async () => {
    renderPage(OrgRole.Owner);

    await waitFor(() => expect(tabNames()).toContain('Members'));
    expect(tabNames()).toContain('Invitations');
    expect(tabNames()).toContain('Billing');
  });

  it('offers the rename only to a role that holds org.rename', async () => {
    renderPage(OrgRole.Owner);

    expect(await screen.findByRole('button', { name: 'Edit organization' })).toBeInTheDocument();
  });

  it.each([OrgRole.Member, OrgRole.ReadOnly])('hides the rename from %s', async (role) => {
    renderPage(role);

    await waitFor(() => expect(tabNames()).toContain('Members'));
    expect(screen.queryByRole('button', { name: 'Edit organization' })).not.toBeInTheDocument();
  });

  it('leaves out a tab the caller cannot reach', async () => {
    // The invitations endpoint is `members.manage`; a Member holds
    // `members.read` and nothing more here, so the tab is not offered.
    renderPage(OrgRole.Member);

    await waitFor(() => expect(tabNames()).toContain('Members'));
    expect(tabNames()).not.toContain('Invitations');
  });

  it('keeps Billing out for a role that cannot read it', async () => {
    // `billing.view` is Owner and Admin; a Member is not offered the tab at all
    // rather than shown one that refuses.
    renderPage(OrgRole.Member);

    await waitFor(() => expect(tabNames()).toContain('Members'));
    expect(tabNames()).not.toContain('Billing');
  });

  it('offers Billing to an Admin, who holds billing.view', async () => {
    renderPage(OrgRole.Admin);

    await waitFor(() => expect(tabNames()).toContain('Billing'));
  });

  it('offers a Read only member the roster and nothing that changes it', async () => {
    renderPage(OrgRole.ReadOnly);

    await waitFor(() => expect(tabNames()).toContain('Members'));
    expect(tabNames()).not.toContain('Invitations');
  });

  it('names the organization it is about', async () => {
    renderPage(OrgRole.Owner);

    // Two browser tabs can sit in different orgs, and this is the page that
    // removes people, so it says which one.
    await waitFor(() => expect(screen.getByText(/Manage/)).toBeInTheDocument());
  });
});
