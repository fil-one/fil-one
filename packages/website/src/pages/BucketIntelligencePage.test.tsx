import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse } from '@filone/shared';

// Stub both outcomes so this test targets the ragAccess routing only, not the
// functional page's data deps or a mounted router.
vi.mock('./RagPipelinePage.js', () => ({
  RagPipelinePage: () => <div data-testid="functional-stub" />,
}));
vi.mock('@tanstack/react-router', () => ({
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => (
    <div data-testid="redirect-stub" data-to={to} data-replace={String(replace)} />
  ),
}));

const mockGetMe = vi.fn();
vi.mock('../lib/api.js', () => ({
  getMe: (...args: unknown[]) => mockGetMe(...args),
}));

import { BucketIntelligencePage } from './BucketIntelligencePage.js';

function me(ragAccess: boolean): MeResponse {
  return {
    orgId: 'org-1',
    orgName: 'Acme',
    nameConfirmed: true,
    emailVerified: true,
    email: 'user@example.com',
    name: 'User',
    mfaEnrollments: [],
    ragAccess,
    billingActive: true,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BucketIntelligencePage />
    </QueryClientProvider>,
  );
}

describe('BucketIntelligencePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the functional page for allowlisted users', async () => {
    mockGetMe.mockResolvedValue(me(true));
    renderPage();

    expect(await screen.findByTestId('functional-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('redirect-stub')).not.toBeInTheDocument();
  });

  it('sends a user off the allowlist to the dashboard, replacing the history entry', async () => {
    mockGetMe.mockResolvedValue(me(false));
    renderPage();

    expect(await screen.findByTestId('redirect-stub')).toMatchObject({
      dataset: { to: '/dashboard', replace: 'true' },
    });
    expect(screen.queryByTestId('functional-stub')).not.toBeInTheDocument();
  });

  it('neither shows the feature nor redirects while /me is loading', () => {
    // Never resolves — keeps the query pending.
    mockGetMe.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('redirect-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('functional-stub')).not.toBeInTheDocument();
  });
});
