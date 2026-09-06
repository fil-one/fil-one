import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { seedPermissions } from '../lib/test-permissions.js';
import { ToastProvider } from './Toast/ToastProvider.js';
import { ReportBugButton } from './ReportBugButton.js';

vi.mock('@sentry/react', () => ({ captureFeedback: vi.fn() }));

function renderButton() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client);
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ReportBugButton />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ReportBugButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a quiet icon button, with the feedback dialog closed', () => {
    renderButton();

    expect(screen.getByRole('button', { name: 'Report a bug' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Describe the issue')).not.toBeInTheDocument();
  });

  it('opens ReportBugDialog on click', async () => {
    renderButton();

    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));

    expect(await screen.findByLabelText('Describe the issue')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });
});
