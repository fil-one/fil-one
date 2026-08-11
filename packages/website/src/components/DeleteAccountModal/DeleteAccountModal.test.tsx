import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiErrorCode } from '@filone/shared';

const mockRequestChallenge = vi.fn();
const mockDeleteAccount = vi.fn();
vi.mock('../../lib/api.js', () => ({
  requestDeletionChallenge: () => mockRequestChallenge(),
  deleteAccount: (req: unknown) => mockDeleteAccount(req),
}));

import { DeleteAccountModal } from '.';

const ORG_NAME = 'Acme Corp';
const RENAMED_ORG = 'Acme Inc';

function renderModal() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DeleteAccountModal open onClose={() => {}} orgName={ORG_NAME} />
    </QueryClientProvider>,
  );
}

function sendCodeButton() {
  return screen.getByRole('button', { name: /send verification code/i });
}

/**
 * Renders the modal with controllable `open` and `orgName` props, mirroring
 * SettingsPage: the modal stays mounted across close/reopen, and the org name
 * it receives can change under it (the company-name form lives on the same
 * page).
 */
function renderReopenableModal() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  let open = true;
  let orgName = ORG_NAME;
  const ui = () => (
    <QueryClientProvider client={client}>
      <DeleteAccountModal open={open} onClose={() => {}} orgName={orgName} />
    </QueryClientProvider>
  );
  const view = render(ui());
  const rerender = () => view.rerender(ui());
  return {
    close() {
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      open = false;
      rerender();
    },
    reopen() {
      open = true;
      rerender();
    },
    closeAndReopen() {
      this.close();
      this.reopen();
    },
    /** Rename the org without unmounting the modal, as SettingsPage does. */
    renameOrgTo(next: string) {
      orgName = next;
      rerender();
    },
  };
}

function setupDefaultChallengeMock() {
  mockRequestChallenge.mockResolvedValue({
    outcome: 'challenge_created',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    resendAvailableAt: new Date(Date.now() + 60 * 1000).toISOString(),
  });
}

describe('DeleteAccountModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultChallengeMock();
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

  it('does not blame an expired code when the 410 is ACCOUNT_DELETED', async () => {
    // Both conditions arrive as 410; only the code distinguishes them.
    mockDeleteAccount.mockRejectedValue(
      Object.assign(new Error('Account has been deleted'), {
        status: 410,
        code: ApiErrorCode.ACCOUNT_DELETED,
      }),
    );
    renderModal();
    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    fireEvent.click(sendCodeButton());
    await waitFor(() => screen.getByLabelText(/enter the 6-digit code/i));

    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: /permanently delete account/i }));

    await waitFor(() => {
      expect(screen.getByText('This account has already been deleted.')).toBeInTheDocument();
    });
    expect(screen.queryByText(/request a new one/i)).not.toBeInTheDocument();
  });

  it('still reports an expired deletion code by its own error code', async () => {
    mockDeleteAccount.mockRejectedValue(
      Object.assign(new Error('Verification code expired'), {
        status: 410,
        code: ApiErrorCode.DELETION_CODE_EXPIRED_OR_LOCKED,
      }),
    );
    renderModal();
    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    fireEvent.click(sendCodeButton());
    await waitFor(() => screen.getByLabelText(/enter the 6-digit code/i));

    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: /permanently delete account/i }));

    await waitFor(() => {
      expect(
        screen.getByText('That code has expired or been locked. Request a new one.'),
      ).toBeInTheDocument();
    });
  });

  it('announces a rejected code to assistive tech and links it to the input via aria-describedby', async () => {
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

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Incorrect verification code');
    const input = screen.getByLabelText(/enter the 6-digit code/i);
    expect(input).toHaveAttribute('aria-describedby', alert.id);
    expect(input).toHaveAttribute('aria-invalid', 'true');
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

describe('DeleteAccountModal success path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultChallengeMock();
  });

  it('on success clears the query cache and hard-navigates to /account-deleted', async () => {
    // The success path had no coverage at all: emptying onSuccess left every test
    // green while the user sat on a dead session looking at the modal. The cache
    // clear matters as much as the redirect — cookies are already gone, so any
    // retained query would refetch against a deleted account.
    // jsdom's Location cannot be assigned to, so swap in a plain object carrying
    // the fields anything else may read — the same approach as lib/api.test.ts.
    const real = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        href: real.href,
        hostname: real.hostname,
        origin: real.origin,
        assign,
      } as unknown as Location,
    });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const clear = vi.spyOn(client, 'clear');
    try {
      render(
        <QueryClientProvider client={client}>
          <DeleteAccountModal open onClose={() => {}} orgName={ORG_NAME} />
        </QueryClientProvider>,
      );
      fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
        target: { value: ORG_NAME },
      });
      fireEvent.click(sendCodeButton());
      await waitFor(() => screen.getByLabelText(/enter the 6-digit code/i));

      mockDeleteAccount.mockResolvedValue({ message: 'Account deleted' });
      fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
        target: { value: '123456' },
      });
      fireEvent.click(screen.getByRole('button', { name: /permanently delete account/i }));

      await waitFor(() => expect(assign).toHaveBeenCalledWith('/account-deleted'));
      // The component's own client, not a module singleton — see useQueryClient.
      expect(clear).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: real });
    }
  });
});

describe('DeleteAccountModal close/reopen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultChallengeMock();
  });

  it('keeps the server cooldown when the modal is closed and reopened', async () => {
    mockRequestChallenge.mockRejectedValue(
      Object.assign(new Error('Too many verification codes requested. Try again later.'), {
        status: 429,
        code: ApiErrorCode.DELETION_RATE_LIMITED,
        resendAvailableAt: new Date(Date.now() + 45 * 1000).toISOString(),
      }),
    );
    const modal = renderReopenableModal();
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
    modal.closeAndReopen();

    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    expect(screen.getByRole('button', { name: /send verification code in \d+s/i })).toBeDisabled();
  });

  it('reopens on the code step while a challenge is live, so a valid emailed code is not stranded', async () => {
    const modal = renderReopenableModal();
    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    fireEvent.click(sendCodeButton());
    await waitFor(() => screen.getByLabelText(/enter the 6-digit code/i));

    // Accidental close (Escape/Cancel) while the emailed code is still valid.
    modal.closeAndReopen();

    // Code entry is still possible — no forced re-confirm + resend against
    // the cooldown. The existing resend affordance is available.
    expect(screen.getByLabelText(/enter the 6-digit code/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resend code in \d+s/i })).toBeDisabled();
    expect(mockRequestChallenge).toHaveBeenCalledOnce();

    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '123456' },
    });
    const deleteButton = screen.getByRole('button', { name: /permanently delete account/i });
    expect(deleteButton).toBeEnabled();

    // The close cleared the typed name and the code step renders no name
    // input, so the payload must come from the name confirmed before the
    // send — otherwise the server rejects an empty orgName and this flow
    // dead-ends with no way back to the confirm step.
    mockDeleteAccount.mockResolvedValue({ message: 'Account deleted' });
    fireEvent.click(deleteButton);
    await waitFor(() => {
      expect(mockDeleteAccount).toHaveBeenCalledWith({ code: '123456', orgName: ORG_NAME });
    });
  });

  it('keeps the confirmed org name in the delete payload when a resend follows a reopen', async () => {
    // No cooldown, so the resend affordance is clickable without timer travel.
    mockRequestChallenge.mockResolvedValue({
      outcome: 'challenge_created',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      resendAvailableAt: new Date(Date.now() - 1000).toISOString(),
    });
    const modal = renderReopenableModal();
    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    fireEvent.click(sendCodeButton());
    await waitFor(() => screen.getByLabelText(/enter the 6-digit code/i));

    modal.closeAndReopen();

    // Resending from the code step re-runs the challenge success path while
    // the typed name is cleared; the snapshot must survive it.
    fireEvent.click(screen.getByRole('button', { name: /^resend code$/i }));
    await waitFor(() => expect(mockRequestChallenge).toHaveBeenCalledTimes(2));

    mockDeleteAccount.mockResolvedValue({ message: 'Account deleted' });
    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: /permanently delete account/i }));
    await waitFor(() => {
      expect(mockDeleteAccount).toHaveBeenCalledWith({ code: '123456', orgName: ORG_NAME });
    });
  });

  it('drops a snapshot the org rename invalidated instead of dead-ending on the code step', async () => {
    // No cooldown, so the re-confirm can send again without timer travel.
    mockRequestChallenge.mockResolvedValue({
      outcome: 'challenge_created',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      resendAvailableAt: new Date(Date.now() - 1000).toISOString(),
    });
    const modal = renderReopenableModal();
    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    fireEvent.click(sendCodeButton());
    await waitFor(() => screen.getByLabelText(/enter the 6-digit code/i));

    // Escape out, then rename the org in the settings form above the modal.
    // The modal never unmounts, so the snapshot outlives the name it captured;
    // submitting it earns a 400 on a step with no name input to correct it.
    modal.close();
    modal.renameOrgTo(RENAMED_ORG);
    modal.reopen();

    expect(screen.queryByLabelText(/enter the 6-digit code/i)).not.toBeInTheDocument();
    expect(
      screen.getByText('The organization name changed. Confirm the new name to continue.'),
    ).toBeInTheDocument();

    // The confirm step now gates on the NEW name, and the payload follows it.
    fireEvent.change(screen.getByLabelText(`Type "${RENAMED_ORG}" to continue`), {
      target: { value: RENAMED_ORG },
    });
    fireEvent.click(sendCodeButton());
    await waitFor(() => screen.getByLabelText(/enter the 6-digit code/i));

    mockDeleteAccount.mockResolvedValue({ message: 'Account deleted' });
    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: /permanently delete account/i }));
    await waitFor(() => {
      expect(mockDeleteAccount).toHaveBeenCalledWith({ code: '123456', orgName: RENAMED_ORG });
    });
  });

  it('still requires the org-name confirmation before the FIRST send after close and reopen', () => {
    const modal = renderReopenableModal();
    // Close without ever sending a code.
    modal.closeAndReopen();

    // Back on the confirm step with the gate intact.
    expect(screen.queryByLabelText(/enter the 6-digit code/i)).not.toBeInTheDocument();
    expect(sendCodeButton()).toBeDisabled();
  });
});

describe('DeleteAccountModal resend countdown (fake timers)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultChallengeMock();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Render, pass the confirm gate, and land on the code step (60s cooldown running). */
  async function renderOnCodeStep() {
    const view = renderModal();
    fireEvent.change(screen.getByLabelText(`Type "${ORG_NAME}" to continue`), {
      target: { value: ORG_NAME },
    });
    fireEvent.click(sendCodeButton());
    // Flush the mutation's microtasks so the step transition commits.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByLabelText(/enter the 6-digit code/i)).toBeInTheDocument();
    return view;
  }

  it('ticks down to zero and re-enables the resend button', async () => {
    await renderOnCodeStep();
    expect(screen.getByRole('button', { name: /resend code in \d+s/i })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });

    expect(screen.getByRole('button', { name: /^resend code$/i })).toBeEnabled();
  });

  it('stops the interval once the countdown reaches zero instead of ticking forever', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    await renderOnCodeStep();
    const intervalId = setIntervalSpy.mock.results[setIntervalSpy.mock.results.length - 1]!
      .value as ReturnType<typeof setInterval>;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });

    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
  });

  it('cleans the countdown interval up on unmount', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const view = await renderOnCodeStep();
    const intervalId = setIntervalSpy.mock.results[setIntervalSpy.mock.results.length - 1]!
      .value as ReturnType<typeof setInterval>;
    expect(clearIntervalSpy).not.toHaveBeenCalledWith(intervalId);

    view.unmount();

    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
  });
});
