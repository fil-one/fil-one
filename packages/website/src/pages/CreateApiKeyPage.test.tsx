import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { seedPermissions } from '../lib/test-permissions.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

// Every test here is about a region serving the `iam` access model.
vi.mock('../lib/access-model.js', () => ({ supportsIamMethods: () => true }));

import { CreateApiKeyPage } from './CreateApiKeyPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedPermissions(qc);
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <CreateApiKeyPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('CreateApiKeyPage — on an iam region', () => {
  it('hides the Scope by bucket advice for a personal key', async () => {
    renderPage();
    expect(await screen.findByText('Follows the bucket policies')).toBeInTheDocument();
    expect(screen.queryByText('Scope by bucket')).not.toBeInTheDocument();
  });

  it('shows Scope by bucket once Service key is chosen', async () => {
    renderPage();
    fireEvent.click(await screen.findByLabelText(/Service key/));
    expect(await screen.findByText('Scope by bucket')).toBeInTheDocument();
  });
});
