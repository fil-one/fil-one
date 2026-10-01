import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { seedPermissions } from '../lib/test-permissions.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

// Every test here is about a region serving the `iam` access model.
vi.mock('../lib/access-model.js', () => ({ isIamRegion: () => true }));

import { CreateApiKeyPage } from './CreateApiKeyPage.js';

describe('CreateApiKeyPage — on an iam region', () => {
  it('does not tell a personal key to scope by bucket', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedPermissions(qc);
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <CreateApiKeyPage />
        </ToastProvider>
      </QueryClientProvider>,
    );

    // The form offers no bucket scope for the default personal key...
    expect(
      await screen.findByText(
        "This key acts as you. What it can reach is decided by each bucket's policy.",
      ),
    ).toBeInTheDocument();
    // ...so the sidebar should not advise scoping it by bucket.
    expect(screen.queryByText('Scope by bucket')).not.toBeInTheDocument();
  });
});
