import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { MemberSummary, MeResponse } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { queryKeys } from '../lib/query-client.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { MembersRoster } from './MembersPage.js';

// ---------------------------------------------------------------------------
// Mocks — API client boundary
// ---------------------------------------------------------------------------

const mockListMembers = vi.fn();
const mockUpdateRole = vi.fn();
const mockRemove = vi.fn();
const mockListInvitations = vi.fn();
const mockTransfer = vi.fn();
const mockRoleChangePreview = vi.fn();

vi.mock('../lib/members-api.js', () => ({
  listMembers: () => mockListMembers(),
  updateMemberRole: (...args: unknown[]) => mockUpdateRole(...args),
  removeMember: (...args: unknown[]) => mockRemove(...args),
  transferOwnership: (...args: unknown[]) => mockTransfer(...args),
  getRoleChangePreview: (...args: unknown[]) => mockRoleChangePreview(...args),
  listInvitations: () => mockListInvitations(),
  createInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
}));

/** No keys to lose, which is what most of these cases are about. */
const NO_KEYS_AT_RISK = {
  currentRole: OrgRole.Owner,
  role: OrgRole.Admin,
  keys: [],
  retainedKeyCount: 0,
  unattributedKeyCount: 0,
};

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
          <MembersRoster />
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

/** Open one row's overflow menu, where its verbs live. */
async function openRowMenu(member: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${member}` }));
}

/** Open a row's menu and choose one of its actions. */
async function chooseRowAction(member: string, action: string) {
  await openRowMenu(member);
  fireEvent.click(await screen.findByRole('menuitem', { name: action }));
}

/**
 * Confirm a narrowing, once its preview has arrived.
 *
 * The button stays inert while the preview loads: a dialog whose whole job is
 * naming the keys a change revokes should not be confirmable before it has
 * named them.
 */
async function confirmNarrowing() {
  const confirm = await screen.findByRole('button', { name: /^Change role/ });
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
}

/** The actions a row offers, or null when it offers no menu at all. */
function rowMenuFor(member: string): HTMLElement | null {
  return screen.queryByRole('button', { name: `Actions for ${member}` });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MembersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListInvitations.mockResolvedValue({ invitations: [] });
    mockRoleChangePreview.mockResolvedValue(NO_KEYS_AT_RISK);
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

    // The count moved to the tab that names this panel, so the roster itself
    // only answers for its rows. `OrganizationPage.test.tsx` covers the count.
    expect(screen.getAllByTestId('member-row')).toHaveLength(3);
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
    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();
  });

  it('lets an Admin manage members below them and not the Owner', async () => {
    renderPage(OrgRole.Admin);

    await screen.findByText('Ada Lovelace');

    // The Owner row is a badge with no verbs on it: every reach at an Owner is
    // `owners.manage`, which an Admin does not hold.
    expect(screen.queryByLabelText('Role for Ada Lovelace')).not.toBeInTheDocument();
    expect(rowMenuFor('Ada Lovelace')).not.toBeInTheDocument();

    // Rows at or below their ceiling carry both.
    expect(screen.getByLabelText('Role for grace@example.com')).toBeInTheDocument();
    expect(rowMenuFor('grace@example.com')).toBeInTheDocument();
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

    await chooseRowAction('grace@example.com', 'Remove');

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

    await confirmNarrowing();
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
    await confirmNarrowing();

    const notice = await screen.findByTestId('members-last-owner');
    expect(notice).toHaveTextContent('Promote another member to owner first.');
    expect(notice).toHaveTextContent('An organization keeps at least one owner');
  });

  it('leaves the role picker usable while its own change is in flight', async () => {
    const finish = heldCalls(mockUpdateRole);
    renderPage();

    // A promotion, which applies on the change event: a demotion revokes keys
    // and is confirmed first, so it never leaves a request in flight here.
    const select = await screen.findByLabelText('Role for Unnamed member');
    (select as HTMLSelectElement).focus();
    fireEvent.change(select, { target: { value: OrgRole.Admin } });

    await waitFor(() =>
      expect(screen.getAllByTestId('member-row')[2]).toHaveAttribute('aria-busy', 'true'),
    );
    // Disabling the control somebody just used drops focus to the body, and
    // nothing puts it back. The row says it is busy instead.
    expect(select).toBeEnabled();
    expect(select).toHaveFocus();

    // The second change is a narrowing, so it asks rather than sending.
    fireEvent.change(select, { target: { value: OrgRole.ReadOnly } });
    expect(mockUpdateRole).toHaveBeenCalledTimes(1);

    await act(async () => finish());
  });

  it('tracks each in-flight row on its own account', async () => {
    const finish = heldCalls(mockUpdateRole);
    renderPage();

    // A demotion, confirmed through the dialog that lists what it revokes.
    fireEvent.change(await screen.findByLabelText('Role for grace@example.com'), {
      target: { value: OrgRole.Member },
    });
    await confirmNarrowing();
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
          <MembersRoster />
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

    await chooseRowAction('grace@example.com', 'Remove');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove member' }));

    expect(await screen.findByTestId('members-stale')).toHaveTextContent('Members are unavailable');
    expect(screen.getAllByTestId('member-row')).toHaveLength(2);
    expect(screen.queryByTestId('members-error')).not.toBeInTheDocument();
  });

  it('keeps a dialog’s copy about somebody through its closing transition', async () => {
    renderPage();

    await chooseRowAction('grace@example.com', 'Remove');
    await screen.findByText('Remove this member?');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // The panel outlives the click by the length of its fade, and copy read off
    // a target already set to null is a sentence about nobody.
    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent(
      'grace@example.com loses access',
    );
  });
});

/**
 * What a demotion costs, before it happens.
 *
 * An access key carries its own permission set, fixed when it was minted, so a
 * member moving to a narrower role keeps whatever their keys already hold until
 * the change takes them away.
 */
describe('the role-narrowing confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListInvitations.mockResolvedValue({ invitations: [] });
    mockRoleChangePreview.mockResolvedValue(NO_KEYS_AT_RISK);
    window.history.replaceState(null, '', '/members');
  });

  it('names the keys a demotion revokes, and the safe order', async () => {
    mockRoleChangePreview.mockResolvedValue({
      currentRole: OrgRole.Admin,
      role: OrgRole.Member,
      keys: [
        {
          id: 'key-1',
          keyName: 'nightly backup',
          accessKeyIdSuffix: '9999',
          region: 'us-east-1',
          createdAt: '2026-02-01T00:00:00.000Z',
          reason: 'exceeds_role',
          excess: ['DeleteBucket'],
        },
      ],
      retainedKeyCount: 2,
      unattributedKeyCount: 1,
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Role for grace@example.com'), {
      target: { value: OrgRole.Member },
    });

    expect(await screen.findByText('nightly backup')).toBeInTheDocument();
    expect(screen.getByText(/carries DeleteBucket/)).toBeInTheDocument();
    expect(screen.getByText(/create a replacement key/)).toBeInTheDocument();
    expect(screen.getByText(/2 of their other keys stay within the new role/)).toBeInTheDocument();
    expect(
      screen.getByText(/1 key in this organization have no recorded owner/),
    ).toBeInTheDocument();
    expect(mockRoleChangePreview).toHaveBeenCalledWith('user-2', OrgRole.Member);
    expect(mockUpdateRole).not.toHaveBeenCalled();
  });

  it('says so when a demotion costs the member nothing', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText('Role for grace@example.com'), {
      target: { value: OrgRole.Member },
    });

    expect(
      await screen.findByText(/None of their access keys carry more than the new role allows/),
    ).toBeInTheDocument();
  });

  it('holds the confirm button down while the change is in flight', async () => {
    // A bespoke dialog has to hold this itself: two clicks would otherwise be
    // two revocations.
    const finish = heldCalls(mockUpdateRole);
    renderPage();

    fireEvent.change(await screen.findByLabelText('Role for grace@example.com'), {
      target: { value: OrgRole.Member },
    });
    await confirmNarrowing();

    const confirm = screen.getByRole('button', { name: /^Chang/ });
    await waitFor(() => expect(confirm).toBeDisabled());
    fireEvent.click(confirm);
    expect(mockUpdateRole).toHaveBeenCalledTimes(1);

    await act(async () => finish());
  });

  it('closes once the change lands', async () => {
    mockUpdateRole.mockResolvedValue({
      userId: 'user-2',
      role: OrgRole.Member,
      previousRole: OrgRole.Admin,
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Role for grace@example.com'), {
      target: { value: OrgRole.Member },
    });
    await confirmNarrowing();

    await waitFor(() => expect(screen.queryByText('Change this role?')).not.toBeInTheDocument());
  });

  it('stays open when the change is refused, beside what it was about to do', async () => {
    mockUpdateRole.mockRejectedValue(apiError('That member’s role changed', 409));
    renderPage();

    fireEvent.change(await screen.findByLabelText('Role for grace@example.com'), {
      target: { value: OrgRole.Member },
    });
    await confirmNarrowing();

    await waitFor(() => expect(screen.getByRole('button', { name: /^Chang/ })).toBeEnabled());
    expect(screen.getByText('Change this role?')).toBeInTheDocument();
  });

  it('drops the cached access keys when a narrowing revoked some', async () => {
    // The roster and the key list are different queries with different stale
    // windows, so an admin coming back to Access keys would otherwise see
    // credentials that no longer exist.
    mockUpdateRole.mockResolvedValue({
      userId: 'user-2',
      role: OrgRole.Member,
      previousRole: OrgRole.Admin,
      revokedKeys: [
        {
          id: 'key-1',
          keyName: 'nightly backup',
          region: 'us-east-1',
          createdAt: '2026-02-01T00:00:00.000Z',
          reason: 'exceeds_role',
          excess: ['DeleteBucket'],
        },
      ],
    });
    const { client } = renderPage();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    fireEvent.change(await screen.findByLabelText('Role for grace@example.com'), {
      target: { value: OrgRole.Member },
    });
    await confirmNarrowing();

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.accessKeys }),
    );
    // And the preview, which was read before any of this and would otherwise go
    // on offering deleted keys as keys the next attempt will revoke.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.roleChangePreviews });
  });

  it('names the keys already revoked when the role write then failed', async () => {
    // Those credentials are gone whatever the role now says.
    mockUpdateRole.mockRejectedValue(
      Object.assign(new Error('That member’s role changed while you were editing it.'), {
        status: 409,
        revokedKeys: [
          {
            id: 'key-1',
            keyName: 'nightly backup',
            region: 'us-east-1',
            createdAt: '2026-02-01T00:00:00.000Z',
            reason: 'exceeds_role',
            excess: ['DeleteBucket'],
          },
        ],
      }),
    );
    renderPage();

    fireEvent.change(await screen.findByLabelText('Role for grace@example.com'), {
      target: { value: OrgRole.Member },
    });
    await confirmNarrowing();

    expect(await screen.findByText(/This key was revoked: nightly backup/)).toBeInTheDocument();
  });

  it('still offers the change when the preview cannot be read', async () => {
    mockRoleChangePreview.mockRejectedValue(apiError('Preview unavailable', 503));
    mockUpdateRole.mockResolvedValue({
      userId: 'user-2',
      role: OrgRole.Member,
      previousRole: OrgRole.Admin,
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Role for grace@example.com'), {
      target: { value: OrgRole.Member },
    });

    expect(await screen.findByText('The affected keys could not be listed')).toBeInTheDocument();
    await confirmNarrowing();
    await waitFor(() => expect(mockUpdateRole).toHaveBeenCalledWith('user-2', OrgRole.Member));
  });
});

describe('MembersPage — a removal the roster is stale for', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListInvitations.mockResolvedValue({ invitations: [] });
    mockRoleChangePreview.mockResolvedValue(NO_KEYS_AT_RISK);
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

    await chooseRowAction('grace@example.com', 'Remove');
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

    await chooseRowAction('grace@example.com', 'Remove');
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
    mockRoleChangePreview.mockResolvedValue(NO_KEYS_AT_RISK);
    window.history.replaceState(null, '', '/members');
  });

  it('offers the transfer on other members’ rows and not on the owner’s own', async () => {
    renderPage();

    await openRowMenu('grace@example.com');
    expect(await screen.findByRole('menuitem', { name: 'Transfer ownership' })).toBeInTheDocument();

    // Transferring to yourself is not a transfer, and an Owner is already one.
    // With nothing else the sole Owner may do to their own row, it carries no
    // menu at all rather than an empty one.
    expect(rowMenuFor('Ada Lovelace')).not.toBeInTheDocument();
  });

  it('does not offer it to an Admin', async () => {
    renderPage(OrgRole.Admin);

    await screen.findByText('Ada Lovelace');
    expect(screen.queryByRole('button', { name: /^Transfer ownership/ })).not.toBeInTheDocument();
  });

  it('holds the transfer until the organization’s name is typed', async () => {
    renderPage();

    await chooseRowAction('grace@example.com', 'Transfer ownership');

    const confirm = await screen.findByRole('button', { name: 'Transfer ownership' });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/becomes owner of Acme/)).toBeVisible();
    expect(screen.getByText(/This action cannot be undone/)).toBeVisible();

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

    await chooseRowAction('grace@example.com', 'Transfer ownership');
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

    await chooseRowAction('grace@example.com', 'Transfer ownership');
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
    expect(screen.getByText(/grace@example.com becomes owner of Acme/)).toBeVisible();
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

// ---------------------------------------------------------------------------
// Search and role filter
// ---------------------------------------------------------------------------

/** A roster long enough for the table to offer its controls. */
const LONG_ROSTER: MemberSummary[] = [
  OWNER,
  ADMIN,
  PLAIN,
  { userId: 'user-4', role: OrgRole.Member, name: 'Grete Hermann' },
  { userId: 'user-5', role: OrgRole.ReadOnly, email: 'katherine@example.com' },
];

function searchBox() {
  return screen.getByLabelText('Search members by name, email, or user ID');
}

function roleFilter() {
  return screen.getByLabelText('Filter members by role');
}

describe('MembersPage search and role filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListInvitations.mockResolvedValue({ invitations: [] });
  });

  it('leaves a short roster alone', async () => {
    renderPage(OrgRole.Owner, [OWNER, ADMIN, PLAIN]);

    await screen.findByText('Ada Lovelace');
    expect(screen.queryByLabelText('Search members by name, email, or user ID')).toBeNull();
    expect(screen.queryByLabelText('Filter members by role')).toBeNull();
  });

  it('narrows the roster by name, email, or user id', async () => {
    renderPage(OrgRole.Owner, LONG_ROSTER);

    await screen.findByText('Ada Lovelace');
    expect(screen.getByText('5 members')).toBeInTheDocument();

    fireEvent.change(searchBox(), { target: { value: 'lovelace' } });
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByText('Grete Hermann')).toBeNull();
    expect(screen.getByText('1 of 5')).toBeInTheDocument();

    // The row with neither a name nor an email is reachable by its id.
    fireEvent.change(searchBox(), { target: { value: 'user-3' } });
    expect(screen.getByText('user-3')).toBeInTheDocument();
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
  });

  it('narrows the roster by role, and combines the two', async () => {
    renderPage(OrgRole.Owner, LONG_ROSTER);

    await screen.findByText('Ada Lovelace');

    fireEvent.change(roleFilter(), { target: { value: OrgRole.Member } });
    expect(screen.getByText('Grete Hermann')).toBeInTheDocument();
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
    expect(screen.getByText('2 of 5')).toBeInTheDocument();

    fireEvent.change(searchBox(), { target: { value: 'hermann' } });
    expect(screen.getByText('1 of 5')).toBeInTheDocument();
  });

  it('offers the roles the roster actually holds, and no filter when it holds one', async () => {
    const { unmount } = renderPage(OrgRole.Owner, LONG_ROSTER);

    await screen.findByText('Ada Lovelace');
    const options = [...roleFilter().querySelectorAll('option')].map((o) => o.textContent);
    // Every role, because this roster happens to hold all four.
    expect(options).toEqual(['All roles', 'Owner', 'Admin', 'Member', 'Read only']);
    unmount();

    const oneRole = Array.from({ length: 5 }, (_, i) => ({
      userId: `same-${i}`,
      role: OrgRole.Member,
    }));
    renderPage(OrgRole.Owner, oneRole);

    await screen.findByText('same-0');
    expect(screen.getByLabelText('Search members by name, email, or user ID')).toBeInTheDocument();
    expect(screen.queryByLabelText('Filter members by role')).toBeNull();
  });

  it('says so when nothing matches, and clears back to the whole roster', async () => {
    renderPage(OrgRole.Owner, LONG_ROSTER);

    await screen.findByText('Ada Lovelace');
    fireEvent.change(searchBox(), { target: { value: 'nobody' } });

    expect(screen.getByText('No matching members')).toBeInTheDocument();
    expect(screen.getByText('0 of 5')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('5 members')).toBeInTheDocument();
  });
});
