import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiErrorCode, MAX_PENDING_INVITATIONS_PER_ORG, OrgRole } from '@filone/shared';
import type { InvitationSummary, MeResponse } from '@filone/shared';

import { ToastProvider } from '../components/Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { ROLE_DESCRIPTIONS } from '../lib/use-member-scope.js';
import { MembersInvitations } from './MembersInvitations.js';

// ---------------------------------------------------------------------------
// Mocks — API client boundary
// ---------------------------------------------------------------------------

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockRevoke = vi.fn();

vi.mock('../lib/members-api.js', () => ({
  listInvitations: () => mockList(),
  createInvitation: (...args: unknown[]) => mockCreate(...args),
  revokeInvitation: (...args: unknown[]) => mockRevoke(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function invitation(over: Partial<InvitationSummary> = {}): InvitationSummary {
  return {
    inviteId: 'inv-1',
    email: 'new@example.com',
    role: OrgRole.Member,
    invitedBy: 'user-1',
    createdAt: '2026-08-01T00:00:00Z',
    expiresAt: '2026-08-15T00:00:00Z',
    status: 'pending',
    expired: false,
    ...over,
  };
}

/**
 * Asks the section to open its dialog the way the Organization page's Add member
 * button does. Set by the harness below on every render, because the section has
 * no trigger of its own once the list has rows: the button lives in the page
 * header, above the tabs.
 */
let requestInviteFromPage: () => void = () => {
  throw new Error('renderSection has not run yet');
};

/** The page's half of the invite request: the flag, and clearing it once read. */
function InvitationsHarness() {
  const [requested, setRequested] = useState(false);
  requestInviteFromPage = () => setRequested(true);
  return (
    <MembersInvitations
      inviteRequested={requested}
      onInviteRequestHandled={() => setRequested(false)}
    />
  );
}

function renderSection(
  role: OrgRole = OrgRole.Owner,
  invitations: InvitationSummary[] = [],
  me: Partial<MeResponse> = {},
) {
  mockList.mockResolvedValue({ invitations });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role, me);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <InvitationsHarness />
        </ToastProvider>
      </QueryClientProvider>,
    ),
  };
}

/** Ask for the dialog the way the page's Add member button does. */
function requestInvite() {
  act(() => {
    requestInviteFromPage();
  });
}

/** An error shaped the way `apiRequest` throws one. */
function apiError(message: string, status: number, code?: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Open the invite dialog, which is where the form lives. Through the empty
 * state's own button when the list has none, and otherwise the way the page
 * header's Add member button does.
 */
async function openInviteDialog() {
  const card = screen.queryByTestId('invitations-empty');
  const cta = card && within(card).queryByRole('button', { name: 'Invite member' });
  if (cta) fireEvent.click(cta);
  else requestInvite();
  return screen.findByTestId('invite-form');
}

/** Type into the invite form, opening the dialog first when it is closed. */
async function typeEmail(value: string) {
  if (!screen.queryByLabelText('Email address')) await openInviteDialog();
  fireEvent.change(await screen.findByLabelText('Email address'), { target: { value } });
}

/** The roles the form is offering, in the order it lists them. */
function roleOptionValues(): string[] {
  return screen.getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value);
}

/** The role the form would submit. */
function checkedRoleValue(): string | undefined {
  const checked = screen
    .getAllByRole('radio')
    .find((radio) => (radio as HTMLInputElement).checked) as HTMLInputElement | undefined;
  return checked?.value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MembersInvitations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says nothing is outstanding when nothing is, and offers the invite', async () => {
    renderSection();

    expect(await screen.findByTestId('invitations-empty')).toBeInTheDocument();
    expect(screen.getByText('No pending invitations')).toBeInTheDocument();

    // The card's own call to action opens the same dialog the header button does.
    const card = screen.getByTestId('invitations-empty');
    fireEvent.click(within(card).getByRole('button', { name: 'Invite member' }));
    expect(await screen.findByTestId('invite-dialog')).toBeInTheDocument();
  });

  it('drops the empty state call to action for a caller who cannot invite', async () => {
    renderSection(OrgRole.ReadOnly);

    const card = await screen.findByTestId('invitations-empty');
    expect(within(card).queryByRole('button', { name: 'Invite member' })).toBeNull();
    expect(
      within(card).getByText('Invitations appear here until they are accepted or withdrawn.'),
    ).toBeInTheDocument();
  });

  it('offers the invite from the empty card only, the page header carrying it otherwise', async () => {
    const { unmount } = renderSection();

    // Empty: the card holds the only button in the section.
    const card = await screen.findByTestId('invitations-empty');
    expect(within(card).getByRole('button', { name: 'Invite member' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Invite member' })).toHaveLength(1);
    unmount();

    renderSection(OrgRole.Owner, [invitation({ email: 'waiting@example.com' })]);

    // With rows, the section holds none: the page header's Add member button is
    // the way in, and it opens this same dialog.
    await screen.findAllByTestId('invitation-row');
    expect(screen.queryByTestId('invitations-empty')).toBeNull();
    expect(screen.queryAllByRole('button', { name: 'Invite member' })).toHaveLength(0);
    expect(await openInviteDialog()).toBeInTheDocument();
  });

  it('drops the empty state call to action outside the beta', async () => {
    renderSection(OrgRole.Owner, [], { orgsBeta: false });

    const card = await screen.findByTestId('invitations-empty');
    expect(within(card).queryByRole('button', { name: 'Invite member' })).toBeNull();
  });

  it('withdraws the form outside the beta and keeps the list that revokes', async () => {
    renderSection(OrgRole.Owner, [invitation({ email: 'waiting@example.com' })], {
      orgsBeta: false,
    });

    // `accept-invitation` carries no beta gate, so the tokens this org already
    // issued stay redeemable after the flag goes. The form is the only half the
    // flag decides; the revoke button is the only way to withdraw a live token.
    expect(await screen.findAllByTestId('invitation-row')).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'Revoke invitation for waiting@example.com' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send invitation' })).not.toBeInTheDocument();
  });

  it('tells an expired invitation from one nobody received', async () => {
    renderSection(OrgRole.Owner, [
      invitation({ inviteId: 'inv-1', email: 'waiting@example.com' }),
      invitation({ inviteId: 'inv-2', email: 'stale@example.com', expired: true }),
      invitation({ inviteId: 'inv-3', email: 'unsent@example.com', lastSendFailed: true }),
    ]);

    expect(await screen.findAllByTestId('invitation-row')).toHaveLength(3);
    expect(screen.getByTestId('invitation-expired')).toHaveTextContent('Expired');
    expect(screen.getByTestId('invitation-undelivered')).toHaveTextContent('Not delivered');
    expect(screen.getByText('Waiting')).toBeInTheDocument();
  });

  it('sends an invitation at the chosen role', async () => {
    mockCreate.mockResolvedValue({ invitation: invitation(), emailSent: true });
    renderSection();

    await typeEmail('new@example.com');
    fireEvent.click(await screen.findByRole('radio', { name: /Admin/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({ email: 'new@example.com', role: OrgRole.Admin }),
    );
  });

  it('bounds the role picker by the caller’s own ceiling', async () => {
    renderSection(OrgRole.Admin);

    await openInviteDialog();
    expect(roleOptionValues()).toEqual([OrgRole.Admin, OrgRole.Member, OrgRole.ReadOnly]);
  });

  it('offers every role to an Owner', async () => {
    renderSection(OrgRole.Owner);

    await openInviteDialog();
    expect(roleOptionValues()).toContain(OrgRole.Owner);
  });

  it('falls back to Member when the ceiling shrinks under the open form', async () => {
    mockCreate.mockResolvedValue({ invitation: invitation(), emailSent: true });
    // An Owner picks Owner, then demotes themselves elsewhere on this page. The
    // form stays mounted while `/me` comes back saying Admin, so the role it is
    // holding is one the server would now refuse.
    const { client } = renderSection(OrgRole.Owner);

    await typeEmail('new@example.com');
    fireEvent.click(await screen.findByRole('radio', { name: /Owner/ }));
    seedPermissions(client, OrgRole.Admin);

    await waitFor(() => expect(checkedRoleValue()).toBe(OrgRole.Member));
    expect(roleOptionValues()).not.toContain(OrgRole.Owner);

    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({ email: 'new@example.com', role: OrgRole.Member }),
    );
  });

  it('does not hand the dropped role back when the ceiling widens again', async () => {
    mockCreate.mockResolvedValue({ invitation: invitation(), emailSent: true });
    // The same Owner, demoted and then made an Owner again while the form stays
    // mounted. The demotion is what settled the picker on Member; nobody has
    // asked for Owner since, so the promotion must not restore it.
    const { client } = renderSection(OrgRole.Owner);

    await typeEmail('new@example.com');
    fireEvent.click(await screen.findByRole('radio', { name: /Owner/ }));
    seedPermissions(client, OrgRole.Admin);
    await waitFor(() => expect(checkedRoleValue()).toBe(OrgRole.Member));

    seedPermissions(client, OrgRole.Owner);

    await waitFor(() => expect(roleOptionValues()).toContain(OrgRole.Owner));
    // The selection and the body both read the same role.
    expect(checkedRoleValue()).toBe(OrgRole.Member);
    expect(screen.getByText(ROLE_DESCRIPTIONS[OrgRole.Member])).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({ email: 'new@example.com', role: OrgRole.Member }),
    );
  });

  it('refuses an invalid address without asking the server', async () => {
    renderSection();

    await typeEmail('not-an-address');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(await screen.findByText('Please provide a valid email address.')).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('says an invitation was created but never delivered, and offers the retry', async () => {
    mockCreate.mockResolvedValue({
      invitation: invitation({ email: 'unsent@example.com', lastSendFailed: true }),
      emailSent: false,
    });
    renderSection();

    await typeEmail('unsent@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    const notice = await screen.findByTestId('invite-undelivered');
    expect(notice).toHaveTextContent("the email wasn't sent");
    expect(notice).toHaveTextContent('unsent@example.com');
    // Re-inviting is the retry, so the form is still there to do it with.
    expect(screen.getByTestId('invite-form')).toBeInTheDocument();
  });

  it('retries an undelivered invitation at the role it was created with', async () => {
    mockCreate.mockResolvedValue({
      invitation: invitation({ email: 'unsent@example.com', role: OrgRole.Admin }),
      emailSent: false,
    });
    renderSection();

    await typeEmail('unsent@example.com');
    fireEvent.click(await screen.findByRole('radio', { name: /Admin/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    const notice = await screen.findByTestId('invite-undelivered');
    // The send cleared the field, as any success does, so the address the retry
    // needs is only held by the alert.
    expect(screen.getByLabelText('Email address')).toHaveValue('');

    mockCreate.mockClear();
    fireEvent.click(within(notice).getByRole('button', { name: 'Send again' }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        email: 'unsent@example.com',
        role: OrgRole.Admin,
      }),
    );
  });
});

describe('MembersInvitations — when the server refuses or the list goes stale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the beta refusal as a state on the form, not an error', async () => {
    mockCreate.mockRejectedValue(
      apiError(
        'Inviting teammates is not enabled for this organization yet.',
        403,
        ApiErrorCode.INVITES_NOT_ENABLED,
      ),
    );
    renderSection();

    await typeEmail('new@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    const state = await screen.findByTestId('invite-not-enabled');
    expect(state).toHaveTextContent('not enabled for this organization yet');
    // The section says so and stops opening the dialog at all.
    requestInvite();
    expect(screen.queryByRole('button', { name: 'Invite member' })).not.toBeInTheDocument();
    // The dialog goes with it: nothing on that form would work.
    await waitFor(() => expect(screen.queryByTestId('invite-form')).not.toBeInTheDocument());
  });

  it('leaves the form up for a 403 that names no refusal', async () => {
    // An expired CSRF cookie answers this way, and it is the routine one: the
    // next attempt works. Reading a code-less 403 as the beta gate took the
    // form off the page for the rest of the visit.
    mockCreate.mockRejectedValue(apiError('Invalid CSRF token', 403));
    renderSection();

    await typeEmail('new@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(await screen.findByTestId('toast')).toHaveTextContent('Invalid CSRF token');
    expect(screen.queryByTestId('invite-not-enabled')).not.toBeInTheDocument();
    expect(screen.getByTestId('invite-form')).toBeInTheDocument();
  });

  it('keeps the address a refusal came back on, and clears it on success', async () => {
    mockCreate
      .mockRejectedValueOnce(apiError('The invitation service is unavailable', 503))
      .mockResolvedValueOnce({
        invitation: invitation({ email: 'new@example.com' }),
        emailSent: true,
      });
    renderSection();

    await typeEmail('new@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    // A refusal on an emptied field leaves nothing to try again with.
    await screen.findByTestId('toast');
    expect(await screen.findByLabelText('Email address')).toHaveValue('new@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(screen.getByLabelText('Email address')).toHaveValue(''));
  });

  it('drops the cap refusal once a revoke frees the slot it named', async () => {
    mockCreate.mockRejectedValue(apiError('Nope', 409, ApiErrorCode.INVITE_LIMIT_REACHED));
    mockRevoke.mockResolvedValue(undefined);
    renderSection(OrgRole.Owner, [invitation({ email: 'waiting@example.com' })]);

    await typeEmail('new@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await screen.findByTestId('invite-cap-reached');
    // The refusal closes the dialog, and asking again at the cap does not
    // reopen it: a form that could only refuse is worse than the alert saying
    // which slot to free.
    await waitFor(() => expect(screen.queryByTestId('invite-form')).not.toBeInTheDocument());
    requestInvite();
    expect(screen.queryByTestId('invite-form')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke invitation for waiting@example.com' }),
    );

    await waitFor(() => expect(screen.queryByTestId('invite-cap-reached')).not.toBeInTheDocument());
    expect(await openInviteDialog()).toBeInTheDocument();
  });

  it('says which field a validation failure is about, and goes back to it', async () => {
    renderSection();

    await typeEmail('not-an-address');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    const message = await screen.findByRole('alert');
    expect(message).toHaveTextContent('Please provide a valid email address.');

    const field = screen.getByLabelText('Email address');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', message.id);
    expect(field).toHaveFocus();
  });
});

describe('MembersInvitations — the list and its rows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a rendered list when a refetch fails', async () => {
    mockRevoke.mockResolvedValue(undefined);
    renderSection(OrgRole.Owner, [
      invitation({ inviteId: 'inv-1', email: 'waiting@example.com' }),
      invitation({ inviteId: 'inv-2', email: 'other@example.com' }),
    ]);

    await screen.findAllByTestId('invitation-row');
    // Every action here invalidates the list, so a refetch follows each one.
    mockList.mockRejectedValue(apiError('Invitations are unavailable', 503));

    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke invitation for waiting@example.com' }),
    );

    expect(await screen.findByTestId('invitations-stale')).toHaveTextContent(
      'Invitations are unavailable',
    );
    // The row the revoke removed is gone; the one beside it is still there.
    expect(screen.getAllByTestId('invitation-row')).toHaveLength(1);
    expect(screen.queryByTestId('invitations-error')).not.toBeInTheDocument();
  });

  it('keeps each in-flight revoke on its own row', async () => {
    const held: Array<() => void> = [];
    mockRevoke.mockImplementation(() => new Promise<void>((resolve) => held.push(resolve)));
    renderSection(OrgRole.Owner, [
      invitation({ inviteId: 'inv-1', email: 'waiting@example.com' }),
      invitation({ inviteId: 'inv-2', email: 'other@example.com' }),
    ]);

    const first = await screen.findByRole('button', {
      name: 'Revoke invitation for waiting@example.com',
    });
    fireEvent.click(first);
    await waitFor(() => expect(first).toBeDisabled());

    // A second revoke must not re-arm the first: one mutation instance carries
    // one set of variables, and the row that asked it first is still going.
    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke invitation for other@example.com' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Revoke invitation for other@example.com' }),
      ).toBeDisabled(),
    );
    expect(first).toBeDisabled();

    held.forEach((resolve) => resolve());
  });

  it('replaces the row for an address the server treats as the same one', async () => {
    mockCreate.mockResolvedValue({
      invitation: invitation({ inviteId: 'inv-2', email: 'bob@example.com' }),
      emailSent: true,
    });
    // The refetch is held, so what is on screen is the optimistic answer alone.
    renderSection(OrgRole.Owner, [invitation({ inviteId: 'inv-1', email: 'Bob@Example.com ' })]);

    await screen.findByTestId('invitation-row');
    mockList.mockReturnValue(new Promise(() => {}));

    await typeEmail('bob@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    await waitFor(() => expect(screen.getAllByTestId('invitation-row')).toHaveLength(1));
    expect(screen.getByTestId('invitation-row')).toHaveAttribute('data-invite-id', 'inv-2');
  });

  it('states the pending cap beside the list the remedy is in', async () => {
    mockCreate.mockRejectedValue(apiError('Nope', 409, ApiErrorCode.INVITE_LIMIT_REACHED));
    renderSection();

    await typeEmail('new@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    // The console states the cap from the shared constant rather than repeating
    // the server's sentence, and it outlives the dialog it was raised in.
    const refusal = await screen.findByTestId('invite-cap-reached');
    expect(refusal).toHaveTextContent(`limit of ${MAX_PENDING_INVITATIONS_PER_ORG}`);
    expect(refusal).toHaveTextContent('Revoke one below');
  });

  it('offers a resend only on a row whose last send failed', async () => {
    mockCreate.mockResolvedValue({
      invitation: invitation({ email: 'unsent@example.com', role: OrgRole.Admin }),
      emailSent: true,
    });
    renderSection(OrgRole.Owner, [
      invitation({ inviteId: 'inv-1', email: 'waiting@example.com' }),
      invitation({
        inviteId: 'inv-2',
        email: 'unsent@example.com',
        role: OrgRole.Admin,
        lastSendFailed: true,
      }),
    ]);

    // Awaited: the actions column depends on `/me`, which lands after the rows.
    const resend = await screen.findByRole('button', {
      name: 'Resend invitation to unsent@example.com',
    });
    // A delivered invitation nobody has answered is waiting, not broken.
    expect(
      screen.queryByRole('button', { name: 'Resend invitation to waiting@example.com' }),
    ).not.toBeInTheDocument();

    fireEvent.click(resend);

    // Re-inviting replaces the row, so the retry is the same call the form makes
    // and it carries the role the invitation already had.
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        email: 'unsent@example.com',
        role: OrgRole.Admin,
      }),
    );
  });

  it('keeps a role refusal in the dialog, beside the picker it is about', async () => {
    mockCreate.mockRejectedValue(
      apiError(
        'Your role in this organization cannot invite someone as Owner.',
        403,
        ApiErrorCode.FORBIDDEN_ROLE,
      ),
    );
    renderSection();

    await typeEmail('new@example.com');
    fireEvent.click(await screen.findByRole('radio', { name: /Owner/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    // A lower role would still work, so the dialog stays open with the refusal
    // in it rather than closing or toasting behind itself.
    expect(await screen.findByTestId('invite-error')).toHaveTextContent('cannot invite someone as');
    expect(screen.getByTestId('invite-form')).toBeInTheDocument();
  });

  it('withdraws an invitation', async () => {
    mockRevoke.mockResolvedValue(undefined);
    renderSection(OrgRole.Owner, [invitation({ email: 'waiting@example.com' })]);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke invitation for waiting@example.com' }),
    );

    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('inv-1'));
  });

  it('does not offer an Admin the revoke on an Owner invitation', async () => {
    renderSection(OrgRole.Admin, [
      invitation({ inviteId: 'inv-1', email: 'boss@example.com', role: OrgRole.Owner }),
      invitation({ inviteId: 'inv-2', email: 'peer@example.com', role: OrgRole.Admin }),
    ]);

    expect(
      await screen.findByRole('button', { name: 'Revoke invitation for peer@example.com' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Revoke invitation for boss@example.com' }),
    ).not.toBeInTheDocument();
  });

  it('surfaces a failed invitations read in place of the list', async () => {
    mockList.mockRejectedValue(apiError('Invitations are unavailable', 503));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedPermissions(client, OrgRole.Owner);
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MembersInvitations />
        </ToastProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('invitations-error')).toHaveTextContent(
      'Invitations are unavailable',
    );
  });
});

describe('MembersInvitations — the alert for an invitation nobody received', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops the alert when the invitation it names is withdrawn', async () => {
    const unsent = invitation({ inviteId: 'inv-1', email: 'unsent@example.com' });
    mockCreate.mockResolvedValue({ invitation: unsent, emailSent: false });
    mockRevoke.mockResolvedValue(undefined);
    renderSection(OrgRole.Owner, [unsent]);

    await typeEmail('unsent@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await screen.findByTestId('invite-undelivered');

    // Left up, it asks for a retry on an invitation that no longer exists.
    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke invitation for unsent@example.com' }),
    );

    await waitFor(() => expect(screen.queryByTestId('invite-undelivered')).not.toBeInTheDocument());
  });

  it('keeps the alert when a different invitation is withdrawn', async () => {
    mockCreate.mockResolvedValue({
      invitation: invitation({ inviteId: 'inv-2', email: 'unsent@example.com' }),
      emailSent: false,
    });
    mockRevoke.mockResolvedValue(undefined);
    renderSection(OrgRole.Owner, [invitation({ inviteId: 'inv-1', email: 'waiting@example.com' })]);

    await typeEmail('unsent@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await screen.findByTestId('invite-undelivered');

    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke invitation for waiting@example.com' }),
    );

    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('inv-1'));
    expect(screen.getByTestId('invite-undelivered')).toBeInTheDocument();
  });
});
