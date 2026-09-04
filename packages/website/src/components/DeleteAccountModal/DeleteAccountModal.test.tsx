import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiErrorCode, DELETION_CODE_LENGTH } from '@filone/shared';

const mockRequest = vi.fn();
const mockConfirm = vi.fn();
vi.mock('../../lib/api', () => ({
  requestAccountDeletion: () => mockRequest(),
  confirmAccountDeletion: (data: unknown) => mockConfirm(data),
}));

import { DeleteAccountModal } from './DeleteAccountModal';

const ORG = 'Acme Corp';
const CODE = '1'.repeat(DELETION_CODE_LENGTH);

function renderModal(onDeleted = vi.fn(), onClose = vi.fn()) {
  render(
    <DeleteAccountModal
      open
      onClose={onClose}
      orgName={ORG}
      soleMembership
      onDeleted={onDeleted}
    />,
  );
  return { onDeleted, onClose };
}

const sendButton = () => screen.getByRole('button', { name: 'Send verification code' });
const deleteButton = () => screen.getByRole('button', { name: 'Delete organization' });

async function advanceToCodeEntry() {
  mockRequest.mockResolvedValue({
    outcome: 'challenge_created',
    expiresAt: '2026-08-12T10:15:00.000Z',
    resendAvailableAt: '2026-08-12T10:01:00.000Z',
  });
  fireEvent.click(sendButton());
  await waitFor(() => expect(screen.getByLabelText('Verification code')).toBeInTheDocument());
}

describe('DeleteAccountModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns before asking for anything, and names the org', () => {
    renderModal();

    expect(screen.getByText('This cannot be undone')).toBeInTheDocument();
    expect(screen.getByText(`This permanently deletes ${ORG}.`)).toBeInTheDocument();
    // No code entry until a code has actually been sent.
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  });

  it('moves to code entry once the code is sent', async () => {
    renderModal();

    await advanceToCodeEntry();

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Organization name')).toBeInTheDocument();
  });

  // Whoever confirmed it, the account is going — showing a code entry that can
  // never succeed would be a lie.
  it('goes straight to the outcome when the deletion is already in progress', async () => {
    const { onDeleted } = renderModal();
    mockRequest.mockResolvedValue({ outcome: 'deletion_in_progress' });

    fireEvent.click(sendButton());

    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  });

  describe('confirm step', () => {
    it('stays disabled until the code is complete and the org name matches', async () => {
      renderModal();
      await advanceToCodeEntry();

      expect(deleteButton()).toBeDisabled();

      fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: CODE } });
      expect(deleteButton()).toBeDisabled();

      fireEvent.change(screen.getByLabelText('Organization name'), {
        target: { value: 'Wrong Corp' },
      });
      expect(deleteButton()).toBeDisabled();

      fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: ORG } });
      expect(deleteButton()).toBeEnabled();
    });

    it('submits the code and the typed org name', async () => {
      const { onDeleted } = renderModal();
      await advanceToCodeEntry();
      mockConfirm.mockResolvedValue({ message: 'deleting' });

      fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: CODE } });
      fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: ORG } });
      fireEvent.click(deleteButton());

      await waitFor(() => expect(onDeleted).toHaveBeenCalled());
      expect(mockConfirm).toHaveBeenCalledWith({ code: CODE, orgName: ORG });
    });

    it('shows the server message on a wrong code, keeping the user on the step', async () => {
      renderModal();
      await advanceToCodeEntry();
      mockConfirm.mockRejectedValue(
        Object.assign(new Error('That verification code is not valid.'), {
          code: ApiErrorCode.DELETION_CODE_INVALID,
        }),
      );

      fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: CODE } });
      fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: ORG } });
      fireEvent.click(deleteButton());

      await waitFor(() =>
        expect(screen.getByText('That verification code is not valid.')).toBeInTheDocument(),
      );
      expect(screen.getByLabelText('Verification code')).toBeInTheDocument();
    });

    // A spent code cannot be retried, so leaving them on the entry step would
    // only produce more failures.
    it('sends the user back for a new code once the old one is locked', async () => {
      renderModal();
      await advanceToCodeEntry();
      mockConfirm.mockRejectedValue(
        Object.assign(new Error('That verification code has expired.'), {
          code: ApiErrorCode.DELETION_CODE_EXPIRED_OR_LOCKED,
        }),
      );

      fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: CODE } });
      fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: ORG } });
      fireEvent.click(deleteButton());

      await waitFor(() => expect(sendButton()).toBeInTheDocument());
      expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
    });
  });

  it('surfaces a failure to send the code', async () => {
    renderModal();
    mockRequest.mockRejectedValue(new Error('A code was sent recently.'));

    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByText('A code was sent recently.')).toBeInTheDocument());
  });

  it('warns that sign-in stops working when this is the only org', () => {
    renderModal();

    expect(screen.getByText(/your sign-in stops working too/)).toBeInTheDocument();
  });

  it('says the account survives when the caller belongs to other orgs too', () => {
    render(
      <DeleteAccountModal
        open
        onClose={vi.fn()}
        orgName={ORG}
        soleMembership={false}
        onDeleted={vi.fn()}
      />,
    );

    expect(screen.getByText(/you keep your account and sign-in/i)).toBeInTheDocument();
  });

  it('clears its state when closed, so a reopen starts at the warning', async () => {
    const { onClose } = renderModal();
    await advanceToCodeEntry();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(sendButton()).toBeInTheDocument();
  });
});
