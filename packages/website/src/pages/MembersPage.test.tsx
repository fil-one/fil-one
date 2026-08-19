import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { MemberSummary, MeResponse } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { queryKeys } from '../lib/query-client.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { MembersPage } from './MembersPage.js';

// ---------------------------------------------------------------------------
// Mocks — API client boundary
// ---------------------------------------------------------------------------

const mockListMembers = vi.fn();
const mockUpdateRole = vi.fn();
const mockRemove = vi.fn();
const mockListInvitations = vi.fn();
const mockTransfer = vi.fn();

vi.mock('../lib/members-api.js', () => ({
  listMembers: () => mockListMembers(),
  updateMemberRole: (...args: unknown[]) => mockUpdateRole(...args),
  removeMember: (...args: unknown[]) => mockRemove(...args),
  transferOwnership: (...args: unknown[]) => mockTransfer(...args),
  listInvitations: () => mockListInvitations(),
  createInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
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

function renderPage(
  role = OrgRole.Owner,
  members: MemberSummary[] = [OWNER, ADMIN, PLAIN],
  me: Partial<MeResponse> = {},
) {
  mockListMembers.mockResolvedValue({ members });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role, me);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MembersPage />
        </ToastProvider>
      </QueryClientProvider>,
    ),
  };
}

/** A mutation that stays in flight until the test lets it finish. */
function heldCalls<T>(mock: { mockImplementation: (fn: () => Promise<T>) => unknown }) {
  const settle: Array<() => void> = [];
  mock.mockImplementation(
    () => new Promise<T>((resolve) => settle.push(() => resolve(undefined as T))),
  );
  return () => settle.forEach((finish) => finish());
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
    window.history.replaceState(null, '', '/members');
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

  it('offers the invitation form when the caller may invite and the org is in the beta', async () => {
    renderPage(OrgRole.Owner);

    expect(await screen.findByTestId('invitations-section')).toBeInTheDocument();
  });

  it('withholds the invitation form in an organization outside the beta', async () => {
    renderPage(OrgRole.Owner, [OWNER, ADMIN, PLAIN], { orgsBeta: false });

    // The roster stays: a caller who belongs to a second org reaches this page
    // in every one of them, and it is creating an invitation that the org's
    // flag decides. Offering the form here would collect one 403 per attempt.
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByTestId('invitations-section')).not.toBeInTheDocument();
  });

  it('withholds the invitation form from a role that cannot manage members', async () => {
    renderPage(OrgRole.Member);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByTestId('invitations-section')).not.toBeInTheDocument();
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

  it('asks before the caller changes their own role', async () => {
    mockUpdateRole.mockResolvedValue({
      userId: 'user-1',
      role: OrgRole.Admin,
      previousRole: OrgRole.Owner,
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Role for Ada Lovelace'), {
      target: { value: OrgRole.Admin },
    });

    // One click or one arrow key used to be enough to give away the caller's
    // own authority, with nobody but somebody else able to give it back.
    expect(await screen.findByText('Change your own role?')).toBeInTheDocument();
    expect(mockUpdateRole).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Change my role' }));
    await waitFor(() => expect(mockUpdateRole).toHaveBeenCalledWith('user-1', OrgRole.Admin));
  });

  it('names the members page the caller is about to lose', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText('Role for Ada Lovelace'), {
      target: { value: OrgRole.Member },
    });

    expect(await screen.findByText(/Managing members goes with it/)).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole('button', { name: 'Change my role' }));

    const notice = await screen.findByTestId('members-last-owner');
    expect(notice).toHaveTextContent('Promote another member to owner first.');
    expect(notice).toHaveTextContent('An organization keeps at least one owner');
  });

  it('leaves the role picker usable while its own change is in flight', async () => {
    const finish = heldCalls(mockUpdateRole);
    renderPage();

    const select = await screen.findByLabelText('Role for grace@example.com');
    (select as HTMLSelectElement).focus();
    fireEvent.change(select, { target: { value: OrgRole.Member } });

    await waitFor(() =>
      expect(screen.getAllByTestId('member-row')[1]).toHaveAttribute('aria-busy', 'true'),
    );
    // Disabling the control somebody just used drops focus to the body, and
    // nothing puts it back. The row says it is busy instead.
    expect(select).toBeEnabled();
    expect(select).toHaveFocus();

    fireEvent.change(select, { target: { value: OrgRole.ReadOnly } });
    expect(mockUpdateRole).toHaveBeenCalledTimes(1);

    await act(async () => finish());
  });

  it('tracks each in-flight row on its own account', async () => {
    const finish = heldCalls(mockUpdateRole);
    renderPage();

    fireEvent.change(await screen.findByLabelText('Role for grace@example.com'), {
      target: { value: OrgRole.Member },
    });
    await waitFor(() =>
      expect(screen.getAllByTestId('member-row')[1]).toHaveAttribute('aria-busy', 'true'),
    );

    fireEvent.change(screen.getByLabelText('Role for Unnamed member'), {
      target: { value: OrgRole.Admin },
    });
    await waitFor(() =>
      expect(screen.getAllByTestId('member-row')[2]).toHaveAttribute('aria-busy', 'true'),
    );

    // One mutation instance carries one set of variables, so the second row
    // starting used to say the first had finished.
    expect(screen.getAllByTestId('member-row')[1]).toHaveAttribute('aria-busy', 'true');

    await act(async () => finish());
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

  it('keeps the roster on screen when a refetch fails', async () => {
    mockRemove.mockResolvedValue(undefined);
    renderPage();

    await screen.findByText('Ada Lovelace');
    // Every change on this page invalidates the roster, so a refetch follows
    // each one — and one that does not come back used to take the page with it.
    mockListMembers.mockRejectedValue(apiError('Members are unavailable', 503));

    fireEvent.click(screen.getByRole('button', { name: 'Remove grace@example.com' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove member' }));

    expect(await screen.findByTestId('members-stale')).toHaveTextContent('Members are unavailable');
    expect(screen.getAllByTestId('member-row')).toHaveLength(2);
    expect(screen.queryByTestId('members-error')).not.toBeInTheDocument();
  });

  it('keeps a dialog’s copy about somebody through its closing transition', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove grace@example.com' }));
    await screen.findByText('Remove this member?');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // The panel outlives the click by the length of its fade, and copy read off
    // a target already set to null is a sentence about nobody.
    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent(
      'grace@example.com loses access',
    );
  });
});

describe('MembersPage — a removal the roster is stale for', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListInvitations.mockResolvedValue({ invitations: [] });
    window.history.replaceState(null, '', '/members');
  });

  // The confirmation closes on its own, so a refusal that leaves the row in
  // place leaves it actionable and every retry earns the same 404.
  it('drops a member the server says is already gone, and re-reads the roster', async () => {
    mockRemove.mockRejectedValue(
      apiError('That person is not a member of this organization.', 404),
    );
    renderPage();
    await screen.findByText('grace@example.com');
    // What the re-read finds: somebody else removed the row first.
    mockListMembers.mockResolvedValue({ members: [OWNER, PLAIN] });

    fireEvent.click(screen.getByRole('button', { name: 'Remove grace@example.com' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove member' }));

    expect(
      await screen.findByText('That person is not a member of this organization.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('grace@example.com')).not.toBeInTheDocument());
    // Two calls: the mount, and the re-read the refusal asked for.
    await waitFor(() => expect(mockListMembers).toHaveBeenCalledTimes(2));
  });

  // The row is still a member — its role moved under the request, so the
  // owner-count delta was decided from the old one. The list is what is stale.
  it('re-reads the roster when a removal loses a race with a role change', async () => {
    mockRemove.mockRejectedValue(
      apiError('That member’s role changed while the removal was in flight — try again.', 409),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove grace@example.com' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove member' }));

    expect(
      await screen.findByText(/role changed while the removal was in flight/),
    ).toBeInTheDocument();
    await waitFor(() => expect(mockListMembers).toHaveBeenCalledTimes(2));
  });
});

describe('MembersPage — transferring the owner seat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListInvitations.mockResolvedValue({ invitations: [] });
    window.history.replaceState(null, '', '/members');
  });

  it('offers the transfer on other members’ rows and not on the owner’s own', async () => {
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Transfer ownership to grace@example.com' }),
    ).toBeInTheDocument();
    // Transferring to yourself is not a transfer, and an Owner is already one.
    expect(
      screen.queryByRole('button', { name: 'Transfer ownership to Ada Lovelace' }),
    ).not.toBeInTheDocument();
  });

  it('does not offer it to an Admin', async () => {
    renderPage(OrgRole.Admin);

    await screen.findByText('Ada Lovelace');
    expect(screen.queryByRole('button', { name: /^Transfer ownership/ })).not.toBeInTheDocument();
  });

  it('holds the transfer until the organization’s name is typed', async () => {
    renderPage();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Transfer ownership to grace@example.com' }),
    );

    const confirm = await screen.findByRole('button', { name: 'Transfer ownership' });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/becomes an owner of Acme, and you become an admin/)).toBeVisible();
    expect(screen.getByText(/You give up your owner role/)).toBeVisible();

    fireEvent.change(screen.getByLabelText('Type Acme to confirm'), {
      target: { value: 'not the org name' },
    });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Type Acme to confirm'), { target: { value: 'Acme' } });
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mockTransfer).toHaveBeenCalledWith('user-2', {
        stepUpAction: 'transfer-ownership:user-2',
      }),
    );
  });

  it('reflects both seats when the transfer lands', async () => {
    // The transfer settles both seats server-side, so the refetch that follows
    // answers with the roster as it now is. The third row is the pin: the
    // optimistic patch touches the two seats and nothing else, so a roster
    // showing it can only have come from the refetch the invalidation asked for.
    mockTransfer.mockImplementation(async () => {
      mockListMembers.mockResolvedValue({
        members: [
          { ...OWNER, role: OrgRole.Admin },
          { ...ADMIN, role: OrgRole.Owner },
          { ...PLAIN, role: OrgRole.ReadOnly },
        ],
      });
      return { userId: 'user-2', previousOwnerUserId: 'user-1' };
    });
    renderPage();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Transfer ownership to grace@example.com' }),
    );
    fireEvent.change(screen.getByLabelText('Type Acme to confirm'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer ownership' }));

    await waitFor(() => {
      const rows = screen.getAllByTestId('member-row');
      expect(rows[0]).toHaveAttribute('data-member-role', OrgRole.Admin);
      expect(rows[1]).toHaveAttribute('data-member-role', OrgRole.Owner);
      expect(rows[2]).toHaveAttribute('data-member-role', OrgRole.ReadOnly);
    });
  });

  it('closes the dialog once the seat has changed hands', async () => {
    mockTransfer.mockResolvedValue({ userId: 'user-2', previousOwnerUserId: 'user-1' });
    renderPage();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Transfer ownership to grace@example.com' }),
    );
    fireEvent.change(screen.getByLabelText('Type Acme to confirm'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer ownership' }));

    // Left open, it offers a destructive button to a caller who is now an
    // Admin, and the server answers the second click with a refusal.
    await waitFor(() => expect(screen.queryByTestId('transfer-dialog')).not.toBeInTheDocument());
    expect(mockTransfer).toHaveBeenCalledTimes(1);
  });

  it('ignores a resumed action naming somebody the caller cannot transfer to', async () => {
    // A trip through Auth0 takes as long as the caller takes, and the roster it
    // comes back to is the one that decides.
    window.history.replaceState(null, '', '/members?action=transfer-ownership:user-2');
    renderPage(OrgRole.Owner, [OWNER, { ...ADMIN, role: OrgRole.Owner }, PLAIN]);

    await screen.findByText('Ada Lovelace');
    expect(screen.queryByTestId('transfer-dialog')).not.toBeInTheDocument();
  });

  it('ignores a resumed action naming the caller themselves', async () => {
    window.history.replaceState(null, '', '/members?action=transfer-ownership:user-1');
    renderPage();

    await screen.findByText('Ada Lovelace');
    expect(screen.queryByTestId('transfer-dialog')).not.toBeInTheDocument();
  });

  it('does not reopen a resumed transfer the roster has already answered', async () => {
    window.history.replaceState(null, '', '/members?action=transfer-ownership:user-2');
    const { client } = renderPage(OrgRole.Owner, [OWNER, PLAIN]);

    await screen.findByText('Ada Lovelace');
    expect(screen.queryByTestId('transfer-dialog')).not.toBeInTheDocument();

    // The member turns up in a later read. The resume was spent when the roster
    // arrived without them, so nothing opens a dialog nobody asked for.
    mockListMembers.mockResolvedValue({ members: [OWNER, ADMIN, PLAIN] });
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.members });
    });

    await waitFor(() => expect(screen.getAllByTestId('member-row')).toHaveLength(3));
    expect(screen.queryByTestId('transfer-dialog')).not.toBeInTheDocument();
  });

  it('reopens the dialog on the member a step-up round trip was about', async () => {
    // The step-up stash carries an action and a return path and nothing else,
    // so the target rides in the action name and comes back on the URL.
    window.history.replaceState(null, '', '/members?action=transfer-ownership:user-2');
    renderPage();

    expect(await screen.findByTestId('transfer-dialog')).toBeInTheDocument();
    expect(screen.getByText(/grace@example.com becomes an owner of Acme/)).toBeVisible();
    // Reopened, not resubmitted: the confirmation has to be given again.
    expect(screen.getByRole('button', { name: 'Transfer ownership' })).toBeDisabled();
    expect(mockTransfer).not.toHaveBeenCalled();

    // And taken out of the URL, so a refresh does not reopen it.
    expect(window.location.search).toBe('');
  });

  it('ignores a resumed action naming somebody who is no longer a member', async () => {
    window.history.replaceState(null, '', '/members?action=transfer-ownership:user-gone');
    renderPage();

    await screen.findByText('Ada Lovelace');
    expect(screen.queryByTestId('transfer-dialog')).not.toBeInTheDocument();
  });
});
