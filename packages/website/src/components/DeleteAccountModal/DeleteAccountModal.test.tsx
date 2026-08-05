import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiErrorCode } from '@filone/shared';

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
      outcome: 'challenge_created',
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

  it('moves keyboard focus to the code input when the challenge succeeds', async () => {
    // The confirm-step button that held focus becomes disabled/replaced on
    // the step change, which would otherwise drop focus to <body>.
    renderModal();
    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    fireEvent.click(sendCodeButton());

    await waitFor(() => {
      expect(screen.getByLabelText(/enter the 6-digit code/i)).toHaveFocus();
    });
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

  it('shows an in-progress message and does not advance when deletion is already running', async () => {
    mockRequestChallenge.mockResolvedValue({ outcome: 'deletion_in_progress' });
    renderModal();
    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    fireEvent.click(sendCodeButton());

    await waitFor(() => {
      expect(screen.getByText('Account deletion is already in progress.')).toBeInTheDocument();
    });
    // Still on the confirm step — no code was emailed, so no code entry.
    expect(screen.queryByLabelText(/enter the 6-digit code/i)).not.toBeInTheDocument();
    expect(sendCodeButton()).toBeInTheDocument();
  });

  it('disables the send button with the server cooldown when the challenge is rate limited', async () => {
    // Server timestamp is 30s out — distinct from the default 60s window, so
    // the assertion proves the countdown came from the 429 body.
    mockRequestChallenge.mockRejectedValue(
      Object.assign(new Error('Too many verification codes requested. Try again later.'), {
        status: 429,
        code: ApiErrorCode.DELETION_RATE_LIMITED,
        resendAvailableAt: new Date(Date.now() + 30 * 1000).toISOString(),
      }),
    );
    renderModal();
    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    fireEvent.click(sendCodeButton());

    await waitFor(() => {
      expect(
        screen.getByText('Too many verification codes requested. Try again later.'),
      ).toBeInTheDocument();
    });
    const button = screen.getByRole('button', { name: /send verification code in \d+s/i });
    expect(button).toBeDisabled();
    const seconds = Number(/in (\d+)s/.exec(button.textContent ?? '')?.[1]);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(30);
  });

  it('keeps the server cooldown when the modal is closed and reopened', async () => {
    mockRequestChallenge.mockRejectedValue(
      Object.assign(new Error('Too many verification codes requested. Try again later.'), {
        status: 429,
        code: ApiErrorCode.DELETION_RATE_LIMITED,
        resendAvailableAt: new Date(Date.now() + 45 * 1000).toISOString(),
      }),
    );
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const ui = (open: boolean) => (
      <QueryClientProvider client={client}>
        <DeleteAccountModal open={open} onClose={() => {}} orgName={ORG_NAME} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui(true));
    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    fireEvent.click(sendCodeButton());
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /send verification code in \d+s/i }),
      ).toBeDisabled();
    });

    // Close (resets step/name/error but not the cooldown) and reopen.
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    rerender(ui(false));
    rerender(ui(true));

    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    expect(screen.getByRole('button', { name: /send verification code in \d+s/i })).toBeDisabled();
  });

  it('states honestly that stored object data is not instantly erased', () => {
    renderModal();
    expect(screen.getByText(/not instantly erased/i)).toBeInTheDocument();
  });

  it('describes cancellation as in-progress — accurate for the async teardown and for trial accounts without a subscription', () => {
    renderModal();
    expect(screen.getByText(/any active subscription is being canceled/i)).toBeInTheDocument();
    expect(screen.queryByText(/canceled immediately/i)).not.toBeInTheDocument();
  });
});
