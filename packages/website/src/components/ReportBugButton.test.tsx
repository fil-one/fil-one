import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgRole } from '@filone/shared';

import { ToastProvider } from './Toast/ToastProvider.js';
import { seedPermissions } from '../lib/test-permissions.js';
import { ReportBugButton } from './ReportBugButton.js';

vi.mock('@sentry/react', () => ({ sendFeedback: vi.fn() }));

function renderButton(variant: 'icon' | 'row') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(client, OrgRole.Owner);
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ReportBugButton variant={variant} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ReportBugButton', () => {
  it.each(['icon', 'row'] as const)('opens the bug-report dialog (%s)', async (variant) => {
    renderButton(variant);

    expect(screen.queryByTestId('report-bug-dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    expect(await screen.findByTestId('report-bug-dialog')).toBeInTheDocument();
  });
});
