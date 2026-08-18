import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { MemberSummary } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { MembersPage } from './MembersPage.js';

// ---------------------------------------------------------------------------
// Mocks — API client boundary
// ---------------------------------------------------------------------------

const mockListMembers = vi.fn();
const mockUpdateRole = vi.fn();
const mockRemove = vi.fn();
const mockListInvitations = vi.fn();

vi.mock('../lib/members-api.js', () => ({
  listMembers: () => mockListMembers(),
  updateMemberRole: (...args: unknown[]) => mockUpdateRole(...args),
  removeMember: (...args: unknown[]) => mockRemove(...args),
  listInvitations: () => mockListInvitations(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// `seedPermissions` writes userId 'user-1', so this is the caller's own row.
const OWNER: MemberSummary = {
  userId: 'user-1',
  role: OrgRole.Owner,
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  joinedAt: '2026-01-05T00:00:00Z',
  source: 'conversion',
};

/** A member the profile row has learned an address for, but no name. */
const ADMIN: MemberSummary = {
  userId: 'user-2',
  role: OrgRole.Admin,
  email: 'grace@example.com',
  joinedAt: '2026-02-01T00:00:00Z',
  source: 'invitation',
  invitedBy: 'user-1',
};

/** The common case today: an id and a role, and nothing else. */
const PLAIN: MemberSummary = {
  userId: 'user-3',
  role: OrgRole.Member,
  joinedAt: '2026-03-01T00:00:00Z',
};

function renderPage(role = OrgRole.Owner, members: MemberSummary[] = [OWNER, ADMIN, PLAIN]) {
  mockListMembers.mockResolvedValue({ members });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MembersPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** An error shaped the way `apiRequest` throws one. */
function apiError(message: string, status: number, code?: string): Error {
  return Object.assign(new Error(message), { status, code });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MembersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListInvitations.mockResolvedValue({ invitations: [] });
  });

  it('lists members, falling back to email and then to the user id', async () => {
    renderPage();

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    // No name on the profile row: the address stands in for it.
    expect(screen.getByText('grace@example.com')).toBeInTheDocument();
    // Neither: the row still identifies somebody, by the id it always has.
    expect(screen.getByText('Unnamed member')).toBeInTheDocument();
    expect(screen.getByText('user-3')).toBeInTheDocument();

    expect(screen.getAllByTestId('member-row')).toHaveLength(3);
    expect(screen.getByText('3 members')).toBeInTheDocument();
  });

  it('marks the caller’s own row', async () => {
    renderPage();

    const rows = await screen.findAllByTestId('member-row');
    expect(rows[0]).toHaveTextContent('You');
    expect(rows[1]).not.toHaveTextContent('You');
  });

  it('shows a read-only member the roster and no way to change it', async () => {
    renderPage(OrgRole.ReadOnly);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
  });

  it('lets an Admin manage members below them and not the Owner', async () => {
    renderPage(OrgRole.Admin);

    await screen.findByText('Ada Lovelace');

    // The Owner row is a badge with no verbs on it: every reach at an Owner is
    // `owners.manage`, which an Admin does not hold.
    expect(screen.queryByLabelText('Role for Ada Lovelace')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Ada Lovelace' })).not.toBeInTheDocument();

    // Rows at or below their ceiling carry both.
    expect(screen.getByLabelText('Role for grace@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove grace@example.com' })).toBeInTheDocument();
  });

  it('offers an Admin no Owner option in the role picker', async () => {
    renderPage(OrgRole.Admin);

    const select = await screen.findByLabelText('Role for grace@example.com');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(options).not.toContain(OrgRole.Owner);
    expect(options).toEqual([OrgRole.Admin, OrgRole.Member, OrgRole.ReadOnly]);
  });

  it('changes an ordinary role without a confirmation', async () => {
    mockUpdateRole.mockResolvedValue({
      userId: 'user-3',
      role: OrgRole.Admin,
      previousRole: OrgRole.Member,
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Role for Unnamed member'), {
      target: { value: OrgRole.Admin },
    });

    await waitFor(() => expect(mockUpdateRole).toHaveBeenCalledWith('user-3', OrgRole.Admin));
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
  });

  it('asks before handing somebody the Owner role', async () => {
    mockUpdateRole.mockResolvedValue({
      userId: 'user-2',
      role: OrgRole.Owner,
      previousRole: OrgRole.Admin,
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Role for grace@example.com'), {
      target: { value: OrgRole.Owner },
    });

    expect(await screen.findByText('Make this member an owner?')).toBeInTheDocument();
    expect(mockUpdateRole).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Make owner' }));
    await waitFor(() => expect(mockUpdateRole).toHaveBeenCalledWith('user-2', OrgRole.Owner));
  });

  it('removes a member after confirmation', async () => {
    mockRemove.mockResolvedValue(undefined);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove grace@example.com' }));

    expect(await screen.findByText('Remove this member?')).toBeInTheDocument();
    // The dialog says what removal does not do, because it does not do it.
    expect(screen.getByText(/Access keys they already created keep working/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('user-2'));
  });

  it('keeps the last-owner refusal on the page with its remedy', async () => {
    mockUpdateRole.mockRejectedValue(
      apiError(
        'This organization would be left without an owner. Promote another member to owner first.',
        409,
        ApiErrorCode.LAST_OWNER,
      ),
    );
    renderPage();

    fireEvent.change(await screen.findByLabelText('Role for Ada Lovelace'), {
      target: { value: OrgRole.Admin },
    });

    const notice = await screen.findByTestId('members-last-owner');
    expect(notice).toHaveTextContent('Promote another member to owner first.');
    expect(notice).toHaveTextContent('An organization keeps at least one owner');
  });

  it('surfaces a failed roster read in place of the table', async () => {
    mockListMembers.mockRejectedValue(apiError('Members are unavailable', 503));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedPermissions(client, OrgRole.Owner);
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MembersPage />
        </ToastProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('members-error')).toHaveTextContent('Members are unavailable');
  });
});
