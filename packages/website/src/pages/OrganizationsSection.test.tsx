import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { MeResponse, OrgMembershipSummary } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { OrganizationsSection } from './OrganizationsSection.js';

const mockRemoveMember = vi.fn();
const mockSwitchToOrg = vi.fn();
const mockListMembers = vi.fn();

vi.mock('../lib/members-api.js', () => ({
  removeMember: (...args: unknown[]) => mockRemoveMember(...args),
  listMembers: (...args: unknown[]) => mockListMembers(...args),
}));

vi.mock('../lib/active-org.js', () => ({
  switchToOrg: (...args: unknown[]) => mockSwitchToOrg(...args),
}));

const ACTIVE_ORG = 'org-1';
const OTHER_ORG = 'org-2';
const USER_ID = 'user-1';

const memberships: OrgMembershipSummary[] = [
  {
    orgId: ACTIVE_ORG,
    orgName: 'Acme',
    slug: 'acme',
    role: OrgRole.Owner,
    joinedAt: '2026-01-15T00:00:00.000Z',
  },
  { orgId: OTHER_ORG, orgName: 'Globex', slug: 'globex', role: OrgRole.Member },
];

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    orgId: ACTIVE_ORG,
    orgName: 'Acme',
    slug: 'acme',
    nameConfirmed: true,
    emailVerified: true,
    email: 'user@example.com',
    mfaEnrollments: [],
    ragAccess: true,
    orgsBeta: true,
    billingActive: true,
    userId: USER_ID,
    role: OrgRole.Owner,
    permissions: [],
    memberships,
    ...overrides,
  };
}

function renderSection(account: MeResponse = me()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <OrganizationsSection me={account} />
        </ToastProvider>
      </QueryClientProvider>,
    ),
  };
}

describe('OrganizationsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Two owners by default, so the "am I the last owner" check the Leave
    // dialog runs stays out of the way of tests that are not about it.
    mockListMembers.mockResolvedValue({
      members: [
        { userId: USER_ID, role: OrgRole.Owner },
        { userId: 'user-2', role: OrgRole.Owner },
      ],
    });
  });

  it('renders nothing for an account with no memberships', () => {
    renderSection(me({ memberships: undefined }));

    expect(screen.queryByText('Organizations')).not.toBeInTheDocument();
  });

  it('lists every organization with its role and join date', () => {
    renderSection();

    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Globex')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('Member')).toBeInTheDocument();
    expect(screen.getByText(/Joined/)).toBeInTheDocument();
  });

  it('offers Leave on the active org, not Switch', async () => {
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Acme' }));

    expect(await screen.findByRole('menuitem', { name: 'Leave organization' })).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Switch to this organization' }),
    ).not.toBeInTheDocument();
  });

  it('offers Switch on a non-active org, not Leave', async () => {
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Globex' }));

    expect(
      await screen.findByRole('menuitem', { name: 'Switch to this organization' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Leave organization' })).not.toBeInTheDocument();
  });

  it('switches into a non-active org', async () => {
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Globex' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Switch to this organization' }));

    expect(mockSwitchToOrg).toHaveBeenCalledWith(OTHER_ORG);
  });

  it('leaves the active org after confirming', async () => {
    mockRemoveMember.mockResolvedValue(undefined);
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Acme' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Leave organization' }));
    const confirmButton = await screen.findByRole('button', { name: 'Leave' });
    await waitFor(() => expect(confirmButton).toBeEnabled());
    fireEvent.click(confirmButton);

    await waitFor(() => expect(mockRemoveMember).toHaveBeenCalledWith(USER_ID));
    expect(await screen.findByText('You left Acme')).toBeInTheDocument();
  });

  it("blocks leaving, with a remedy, when the caller is the org's only owner", async () => {
    mockListMembers.mockResolvedValue({ members: [{ userId: USER_ID, role: OrgRole.Owner }] });
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Acme' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Leave organization' }));

    expect(await screen.findByText(/no other owner/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Leave' })).toBeDisabled());
    expect(mockRemoveMember).not.toHaveBeenCalled();
  });

  it('never checks ownership for a non-Owner, who cannot hit LAST_OWNER', async () => {
    renderSection(me({ role: OrgRole.Member }));

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Acme' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Leave organization' }));

    expect(await screen.findByRole('button', { name: 'Leave' })).toBeEnabled();
    expect(mockListMembers).not.toHaveBeenCalled();
  });

  it('shows the last-owner remedy instead of a generic failure', async () => {
    mockRemoveMember.mockRejectedValue(
      Object.assign(new Error('This organization would be left without an owner.'), {
        code: ApiErrorCode.LAST_OWNER,
      }),
    );
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Acme' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Leave organization' }));
    const confirmButton = await screen.findByRole('button', { name: 'Leave' });
    await waitFor(() => expect(confirmButton).toBeEnabled());
    fireEvent.click(confirmButton);

    expect(
      await screen.findByText('This organization would be left without an owner.'),
    ).toBeInTheDocument();
  });
});
