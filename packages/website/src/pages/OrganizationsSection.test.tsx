import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { MeResponse, OrgMembershipSummary } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { OrganizationsSection } from './OrganizationsSection.js';

const mockRemoveMember = vi.fn();
const mockSwitchToOrg = vi.fn();

vi.mock('../lib/members-api.js', () => ({
  removeMember: (...args: unknown[]) => mockRemoveMember(...args),
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
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));

    await waitFor(() => expect(mockRemoveMember).toHaveBeenCalledWith(USER_ID));
    expect(await screen.findByText('You left Acme')).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));

    expect(
      await screen.findByText('This organization would be left without an owner.'),
    ).toBeInTheDocument();
  });
});
