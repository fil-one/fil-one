import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { MembersPage } from './MembersPage.js';

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

function renderPage(
  role: OrgRole = OrgRole.Owner,
  members = 0,
  invitations = 0,
  me: Partial<MeResponse> = {},
) {
  mockListMembers.mockResolvedValue({
    members: Array.from({ length: members }, (_, i) => ({ userId: `u${String(i)}`, role })),
  });
  mockListInvitations.mockResolvedValue({
    invitations: Array.from({ length: invitations }, (_, i) => ({ inviteId: `i${String(i)}` })),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role, me);
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MembersPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The tabs on offer, in the order the page lists them. */
function tabNames(): string[] {
  return screen.queryAllByRole('tab').map((tab) => tab.textContent ?? '');
}

describe('MembersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is titled Members, with no org identity or rename on it', async () => {
    renderPage(OrgRole.Owner);

    // Identity and rename live in the org switcher now, not on this page.
    expect(await screen.findByRole('heading', { name: 'Members' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Billing/ })).not.toBeInTheDocument();
  });

  it('gives a role that can manage both people tabs', async () => {
    renderPage(OrgRole.Owner);

    await waitFor(() => expect(tabNames()).toContain('Members'));
    expect(tabNames()).toContain('Invitations');
  });

  it('adds a member from the page header, whichever tab is showing', async () => {
    renderPage(OrgRole.Owner, 2, 0);

    // Starts on Members, so the Invitations panel that owns the dialog is not
    // even mounted yet.
    await waitFor(() => expect(tabNames()).toContain('Members'));
    expect(screen.queryByTestId('invite-dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('org-invite-button'));

    // The button brings the caller to Invitations and opens the dialog there.
    expect(await screen.findByTestId('invite-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('org-tab-invitations')).toHaveAttribute('data-selected');
  });

  it('offers Add member to an Owner even outside the old beta', async () => {
    // The invite gate on `orgsBeta` is gone: invitations are generally
    // available, so `members.manage` alone is the question.
    renderPage(OrgRole.Owner, 0, 0, { orgsBeta: false });

    expect(await screen.findByTestId('org-invite-button')).toBeInTheDocument();
    expect(tabNames()).toContain('Invitations');
  });

  it('hides Invitations and Add member from a role without members.manage', async () => {
    renderPage(OrgRole.Member);

    await waitFor(() => expect(tabNames()).toContain('Members'));
    expect(tabNames()).not.toContain('Invitations');
    expect(screen.queryByTestId('org-invite-button')).not.toBeInTheDocument();
  });

  it('offers a Read only member the roster and nothing that changes it', async () => {
    renderPage(OrgRole.ReadOnly);

    await waitFor(() => expect(tabNames()).toContain('Members'));
    expect(tabNames()).not.toContain('Invitations');
    expect(screen.queryByTestId('org-invite-button')).not.toBeInTheDocument();
  });

  it('counts each list on its own tab', async () => {
    renderPage(OrgRole.Owner, 4, 2);

    await waitFor(() => expect(screen.getByTestId('org-tab-members')).toHaveTextContent('4'));
    expect(screen.getByTestId('org-tab-invitations')).toHaveTextContent('2');

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Members4',
      'Invitations2',
    ]);
  });
});
