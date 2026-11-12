import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import * as Sentry from '@sentry/react';

import { ToastProvider } from './Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { ReportBugDialog, SCREENSHOT_MAX_BYTES } from './ReportBugDialog.js';

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

/** An image file of the given type and byte length; its content does not matter. */
function anyImage({ type = 'image/png', bytes = 4 }: { type?: string; bytes?: number } = {}) {
  return new File([new Uint8Array(bytes)], 'any-name.png', { type });
}

/** Types a description, so Send is enabled and the report can go. */
async function describeIssue() {
  fireEvent.change(await screen.findByLabelText('Describe the issue'), {
    target: { value: 'The upload button does nothing' },
  });
}

function pickFile(file: File) {
  fireEvent.change(screen.getByLabelText('Screenshot file'), { target: { files: [file] } });
}

describe('ReportBugDialog screenshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Sentry.sendFeedback).mockResolvedValue('event-id');
    // jsdom has no object URLs; the preview only needs a string to show.
    URL.createObjectURL = vi.fn(() => 'blob:any-preview');
    URL.revokeObjectURL = vi.fn();
  });

  it('sends a picked screenshot as an attachment on the report', async () => {
    renderDialog();
    await describeIssue();

    pickFile(anyImage({ type: 'image/png', bytes: 4 }));
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await waitFor(() =>
      expect(Sentry.sendFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'The upload button does nothing' }),
        {
          attachments: [
            { filename: 'screenshot.png', contentType: 'image/png', data: new Uint8Array(4) },
          ],
        },
      ),
    );
  });

  it.each([
    [
      'pasted',
      (file: File) =>
        fireEvent.paste(screen.getByLabelText('Describe the issue'), {
          clipboardData: { files: [file] },
        }),
    ],
    [
      'dropped',
      (file: File) =>
        fireEvent.drop(screen.getByTestId('report-bug-drop-area'), {
          dataTransfer: { files: [file], types: ['Files'] },
        }),
    ],
  ])('attaches a %s image', async (_how, addImage) => {
    renderDialog();
    await describeIssue();

    addImage(anyImage());

    expect(await screen.findByRole('img', { name: 'Attached screenshot' })).toBeInTheDocument();
  });

  it('leaves a pasted text to the field and attaches nothing', async () => {
    renderDialog();
    await describeIssue();

    fireEvent.paste(screen.getByLabelText('Describe the issue'), {
      clipboardData: { files: [] },
    });

    expect(screen.getByRole('button', { name: 'Attach screenshot' })).toBeInTheDocument();
  });

  it.each([
    // A GIF is an image, but not one a screenshot tool produces.
    ['an unsupported type', anyImage({ type: 'image/gif' }), 'Attach a PNG, JPEG or WebP image'],
    // One byte over the limit.
    [
      'an image over the size limit',
      anyImage({ bytes: SCREENSHOT_MAX_BYTES + 1 }),
      'Attach an image up to 5 MB',
    ],
  ])('refuses %s and says why', async (_case, file, error) => {
    renderDialog();
    await describeIssue();

    pickFile(file);

    expect(await screen.findByText(error)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Attached screenshot' })).not.toBeInTheDocument();
  });

  it('sends without an attachment once the screenshot is removed', async () => {
    renderDialog();
    await describeIssue();

    pickFile(anyImage());
    fireEvent.click(await screen.findByRole('button', { name: 'Remove screenshot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await waitFor(() => expect(Sentry.sendFeedback).toHaveBeenCalled());
    expect(vi.mocked(Sentry.sendFeedback).mock.calls[0]).toHaveLength(1);
  });

  it('drops the screenshot when the dialog is reopened', async () => {
    const { setOpen } = renderDialog();
    await describeIssue();

    pickFile(anyImage());
    await screen.findByRole('img', { name: 'Attached screenshot' });
    setOpen(false);
    setOpen(true);

    expect(await screen.findByRole('button', { name: 'Attach screenshot' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Attached screenshot' })).not.toBeInTheDocument();
  });

  it('reminds the sender to check the screenshot for secret keys', async () => {
    renderDialog();
    await describeIssue();

    pickFile(anyImage());

    expect(await screen.findByText(/Check it shows no secret keys/)).toBeInTheDocument();
  });
});
