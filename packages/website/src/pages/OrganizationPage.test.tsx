import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

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

function renderPage(
  role = OrgRole.Owner,
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

    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
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

  it('hides the add from a role that cannot invite, and outside the beta', async () => {
    renderPage(OrgRole.Member);
    await waitFor(() => expect(tabNames()).toContain('Members'));
    expect(screen.queryByTestId('org-invite-button')).not.toBeInTheDocument();

    renderPage(OrgRole.Owner, 0, 0, { orgsBeta: false });
    await waitFor(() => expect(tabNames()).toContain('Members'));
    expect(screen.queryByTestId('org-invite-button')).not.toBeInTheDocument();
  });

  it.each([OrgRole.Member, OrgRole.ReadOnly])('hides the rename from %s', async (role) => {
    renderPage(role);

    await waitFor(() => expect(tabNames()).toContain('Members'));
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
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

  it('counts each list on its own tab', async () => {
    renderPage(OrgRole.Owner, 4, 2);

    // The number belongs with the label somebody reads before choosing a tab.
    await waitFor(() => expect(screen.getByTestId('org-tab-members')).toHaveTextContent('4'));
    expect(screen.getByTestId('org-tab-invitations')).toHaveTextContent('2');
    // Neither the audit log nor billing counts anything, so neither carries a
    // number.
    expect(screen.getByTestId('org-tab-audit')).toHaveTextContent(/^Audit log$/);
    expect(screen.getByTestId('org-tab-billing')).toHaveTextContent(/^Billing$/);

    // People first, money last, and the audit log after the two tabs whose
    // changes it records.
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Members4',
      'Invitations2',
      'Audit log',
      'Billing',
    ]);
  });

  it('names the organization it is about', async () => {
    renderPage(OrgRole.Owner);

    // Two browser tabs can sit in different orgs, and this is the page that
    // removes people, so it says which one.
    await waitFor(() => expect(screen.getByText(/Manage/)).toBeInTheDocument());
  });
});
