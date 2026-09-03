import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';
import * as Sentry from '@sentry/react';

import { ToastProvider } from './Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { ReportBugDialog } from './ReportBugDialog.js';

vi.mock('@sentry/react', () => ({ captureFeedback: vi.fn() }));

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner, { name: 'Ada Lovelace', email: 'ada@example.com' });
  return {
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <ReportBugDialog open onClose={onClose} />
        </ToastProvider>
      </QueryClientProvider>,
    ),
  };
}

describe('ReportBugDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens empty, with Send disabled until there is something to send', async () => {
    renderDialog();

    expect(await screen.findByLabelText('Describe the issue')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Describe the issue'), {
      target: { value: 'The upload button does nothing' },
    });
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('a blank-only description does not count as something to send', async () => {
    renderDialog();

    fireEvent.change(await screen.findByLabelText('Describe the issue'), {
      target: { value: '   ' },
    });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('sends the report to Sentry with the signed-in identity, then closes', async () => {
    const { onClose } = renderDialog();

    fireEvent.change(await screen.findByLabelText('Describe the issue'), {
      target: { value: '  The upload button does nothing  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(Sentry.captureFeedback).toHaveBeenCalledWith({
        // Trimmed, the way the field's enablement is judged.
        message: 'The upload button does nothing',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
