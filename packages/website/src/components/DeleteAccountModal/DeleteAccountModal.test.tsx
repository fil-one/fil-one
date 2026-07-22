import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockRequestChallenge = vi.fn();
const mockDeleteAccount = vi.fn();
vi.mock('../../lib/api.js', () => ({
  requestDeletionChallenge: () => mockRequestChallenge(),
  deleteAccount: (req: unknown) => mockDeleteAccount(req),
  DELETE_ACCOUNT_STEP_UP_ACTION: 'delete-account',
}));

import { DeleteAccountModal } from '.';

const ORG_NAME = 'Acme Corp';

function renderModal(props?: Partial<Parameters<typeof DeleteAccountModal>[0]>) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DeleteAccountModal open onClose={() => {}} orgName={ORG_NAME} {...props} />
    </QueryClientProvider>,
  );
}

function sendCodeButton() {
  return screen.getByRole('button', { name: /send verification code/i });
}

describe('DeleteAccountModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestChallenge.mockResolvedValue({
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      resendAvailableAt: new Date(Date.now() + 60 * 1000).toISOString(),
    });
  });

  it('disables "Send verification code" until the exact org name is typed', () => {
    renderModal();
    expect(sendCodeButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: 'acme corp' }, // wrong case — not an exact match
    });
    expect(sendCodeButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    expect(sendCodeButton()).toBeEnabled();
  });

  it('accepts surrounding whitespace in the typed name', () => {
    renderModal();
    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: `  ${ORG_NAME}  ` },
    });
    expect(sendCodeButton()).toBeEnabled();
  });

  it('requests the challenge and advances to the code step', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    fireEvent.click(sendCodeButton());

    await waitFor(() => {
      expect(screen.getByLabelText(/enter the 6-digit code/i)).toBeInTheDocument();
    });
    expect(mockRequestChallenge).toHaveBeenCalledOnce();
    // Resend is under cooldown right after the send.
    expect(screen.getByRole('button', { name: /resend code in/i })).toBeDisabled();
  });

  it('keeps the delete button disabled until 6 digits are entered, then submits', async () => {
    mockDeleteAccount.mockResolvedValue({ message: 'Account deleted' });
    renderModal();
    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    fireEvent.click(sendCodeButton());
    await waitFor(() => screen.getByLabelText(/enter the 6-digit code/i));

    const deleteButton = screen.getByRole('button', { name: /permanently delete account/i });
    expect(deleteButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '12345' },
    });
    expect(deleteButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '123456' },
    });
    expect(deleteButton).toBeEnabled();

    fireEvent.click(deleteButton);
    await waitFor(() => {
      expect(mockDeleteAccount).toHaveBeenCalledWith({ code: '123456', orgName: ORG_NAME });
    });
  });

  it('shows an inline error when the code is rejected', async () => {
    mockDeleteAccount.mockRejectedValue(
      Object.assign(new Error('Incorrect verification code'), { status: 400 }),
    );
    renderModal();
    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    fireEvent.click(sendCodeButton());
    await waitFor(() => screen.getByLabelText(/enter the 6-digit code/i));

    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /permanently delete account/i }));

    await waitFor(() => {
      expect(screen.getByText('Incorrect verification code')).toBeInTheDocument();
    });
  });

  it('states honestly that stored object data is not instantly erased', () => {
    renderModal();
    expect(screen.getByText(/not instantly erased/i)).toBeInTheDocument();
  });
});
