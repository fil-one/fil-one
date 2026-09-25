import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import * as Sentry from '@sentry/react';

import { ToastProvider } from './Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { ReportBugDialog } from './ReportBugDialog.js';

vi.mock('@sentry/react', () => ({ sendFeedback: vi.fn() }));

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner, { name: 'Ada Lovelace', email: 'ada@example.com' });
  const dialog = (open: boolean) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ReportBugDialog open={open} onClose={onClose} />
      </ToastProvider>
    </QueryClientProvider>
  );
  const rendered = render(dialog(true));
  return { onClose, ...rendered, setOpen: (open: boolean) => rendered.rerender(dialog(open)) };
}

describe('ReportBugDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Sentry.sendFeedback).mockResolvedValue('event-id');
  });

  it('opens empty, with Send disabled until there is something to send', async () => {
    renderDialog();

    expect(await screen.findByLabelText('Describe the issue')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Send report' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Describe the issue'), {
      target: { value: 'The upload button does nothing' },
    });
    expect(screen.getByRole('button', { name: 'Send report' })).toBeEnabled();
  });

  it('a blank-only description does not count as something to send', async () => {
    renderDialog();

    fireEvent.change(await screen.findByLabelText('Describe the issue'), {
      target: { value: '   ' },
    });
    expect(screen.getByRole('button', { name: 'Send report' })).toBeDisabled();
  });

  it('sends the report to Sentry with the signed-in identity, then closes', async () => {
    const { onClose } = renderDialog();

    fireEvent.change(await screen.findByLabelText('Describe the issue'), {
      target: { value: '  The upload button does nothing  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await waitFor(() =>
      expect(Sentry.sendFeedback).toHaveBeenCalledWith({
        // Trimmed, the way the field's enablement is judged.
        message: 'The upload button does nothing',
        url: window.location.href,
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('keeps the dialog open with the description when the report is not delivered', async () => {
    vi.mocked(Sentry.sendFeedback).mockRejectedValue('Unable to send Feedback');
    const { onClose } = renderDialog();

    fireEvent.change(await screen.findByLabelText('Describe the issue'), {
      target: { value: 'The upload button does nothing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));

    expect(
      await screen.findByText('We could not send that report. Please try again.'),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Describe the issue')).toHaveValue(
      'The upload button does nothing',
    );
    expect(screen.getByRole('button', { name: 'Send report' })).toBeEnabled();
  });

  it('scrubs an invitation token out of the URL the report records', async () => {
    window.history.replaceState(null, '', '/invite/accept#token=secret');
    renderDialog();

    fireEvent.change(await screen.findByLabelText('Describe the issue'), {
      target: { value: 'The upload button does nothing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await waitFor(() =>
      expect(Sentry.sendFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringMatching(/\/invite\/accept#token=REDACTED$/),
        }),
      ),
    );
    window.history.replaceState(null, '', '/');
  });

  it('starts from an empty field when reopened', async () => {
    const { setOpen } = renderDialog();

    fireEvent.change(await screen.findByLabelText('Describe the issue'), {
      target: { value: 'Abandoned draft' },
    });
    setOpen(false);
    setOpen(true);

    expect(await screen.findByLabelText('Describe the issue')).toHaveValue('');
  });

  it('cannot be dismissed while the report is sending', async () => {
    vi.mocked(Sentry.sendFeedback).mockReturnValue(new Promise(() => {}));
    const { onClose } = renderDialog();

    fireEvent.change(await screen.findByLabelText('Describe the issue'), {
      target: { value: 'The upload button does nothing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));

    expect(await screen.findByRole('button', { name: 'Sending...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Describe the issue'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
