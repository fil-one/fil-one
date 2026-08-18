import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiErrorCode, OrgRole } from '@filone/shared';
import type { InvitationSummary } from '@filone/shared';

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

function renderSection(role = OrgRole.Owner, invitations: InvitationSummary[] = []) {
  mockList.mockResolvedValue({ invitations });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, role);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MembersInvitations />
        </ToastProvider>
      </QueryClientProvider>,
    ),
  };
}

/** An error shaped the way `apiRequest` throws one. */
function apiError(message: string, status: number, code?: string): Error {
  return Object.assign(new Error(message), { status, code });
}

async function typeEmail(value: string) {
  fireEvent.change(await screen.findByLabelText('Email address'), { target: { value } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MembersInvitations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says nothing is outstanding when nothing is', async () => {
    renderSection();
    expect(await screen.findByTestId('invitations-empty')).toBeInTheDocument();
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
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: OrgRole.Admin } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({ email: 'new@example.com', role: OrgRole.Admin }),
    );
  });

  it('bounds the role picker by the caller’s own ceiling', async () => {
    renderSection(OrgRole.Admin);

    const select = await screen.findByLabelText('Role');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual([OrgRole.Admin, OrgRole.Member, OrgRole.ReadOnly]);
  });

  it('offers every role to an Owner', async () => {
    renderSection(OrgRole.Owner);

    const select = await screen.findByLabelText('Role');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(options).toContain(OrgRole.Owner);
  });

  it('falls back to Member when the ceiling shrinks under the open form', async () => {
    mockCreate.mockResolvedValue({ invitation: invitation(), emailSent: true });
    // An Owner picks Owner, then demotes themselves elsewhere on this page. The
    // form stays mounted while `/me` comes back saying Admin, so the role it is
    // holding is one the server would now refuse.
    const { client } = renderSection(OrgRole.Owner);

    await typeEmail('new@example.com');
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: OrgRole.Owner } });
    seedPermissions(client, OrgRole.Admin);

    await waitFor(() => expect(screen.getByLabelText('Role')).toHaveValue(OrgRole.Member));
    const options = Array.from(screen.getByLabelText('Role').querySelectorAll('option')).map(
      (o) => o.value,
    );
    expect(options).not.toContain(OrgRole.Owner);

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
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: OrgRole.Owner } });
    seedPermissions(client, OrgRole.Admin);
    await waitFor(() => expect(screen.getByLabelText('Role')).toHaveValue(OrgRole.Member));

    seedPermissions(client, OrgRole.Owner);

    await waitFor(() =>
      expect(
        Array.from(screen.getByLabelText('Role').querySelectorAll('option')).map((o) => o.value),
      ).toContain(OrgRole.Owner),
    );
    // The picker, the sentence under it, and the body all read the same role.
    expect(screen.getByLabelText('Role')).toHaveValue(OrgRole.Member);
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
    expect(notice).toHaveTextContent('the email did not go out');
    expect(notice).toHaveTextContent('unsent@example.com');
    // Re-inviting is the retry, so the form is still there to do it with.
    expect(screen.getByTestId('invite-form')).toBeInTheDocument();
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
    // The controls go: nothing on this form would work.
    expect(screen.queryByTestId('invite-form')).not.toBeInTheDocument();
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
      .mockRejectedValueOnce(apiError('Nope', 409, ApiErrorCode.INVITE_LIMIT_REACHED))
      .mockResolvedValueOnce({
        invitation: invitation({ email: 'new@example.com' }),
        emailSent: true,
      });
    renderSection();

    await typeEmail('new@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    // A 409 on an emptied field leaves nothing to try again with.
    await screen.findByTestId('invite-error');
    expect(await screen.findByLabelText('Email address')).toHaveValue('new@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(screen.getByLabelText('Email address')).toHaveValue(''));
  });

  it('drops the cap alert once a revoke frees the slot it named', async () => {
    mockCreate.mockRejectedValue(
      apiError(
        'This organization already has 25 pending invitations. Revoke one before sending another.',
        409,
        ApiErrorCode.INVITE_LIMIT_REACHED,
      ),
    );
    mockRevoke.mockResolvedValue(undefined);
    renderSection(OrgRole.Owner, [invitation({ email: 'waiting@example.com' })]);

    await typeEmail('new@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await screen.findByTestId('invite-error');

    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke invitation for waiting@example.com' }),
    );

    await waitFor(() => expect(screen.queryByTestId('invite-error')).not.toBeInTheDocument());
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

  it('keeps the pending cap on the form so the remedy is beside the list', async () => {
    mockCreate.mockRejectedValue(
      apiError(
        'This organization already has 25 pending invitations. Revoke one before sending another.',
        409,
        ApiErrorCode.INVITE_LIMIT_REACHED,
      ),
    );
    renderSection();

    await typeEmail('new@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(await screen.findByTestId('invite-error')).toHaveTextContent(
      'Revoke one before sending another.',
    );
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
