import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse } from '@filone/shared';

// Stub both outcomes so this test targets the ragAccess routing only, not the
// functional page's data deps or a mounted router.
// The loading and error states are the real ones: only the loaded page is stubbed.
vi.mock('./RagPipelinePage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./RagPipelinePage.js')>()),
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

  it('shows the page heading and a loading bucket list while /me is loading', () => {
    // Never resolves, so the query stays pending.
    mockGetMe.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Bucket Intelligence' })).toBeVisible();
    expect(screen.getByRole('status', { name: 'Loading buckets' })).toBeInTheDocument();
  });

  it('neither shows the feature nor redirects while /me is loading', () => {
    mockGetMe.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(screen.queryByTestId('redirect-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('functional-stub')).not.toBeInTheDocument();
  });

  it('says the page did not load when /me fails, instead of loading forever', async () => {
    mockGetMe.mockRejectedValue(new Error('any failure'));
    renderPage();

    expect(await screen.findByText('This page did not load')).toBeVisible();
    expect(screen.queryByRole('status', { name: 'Loading buckets' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('redirect-stub')).not.toBeInTheDocument();
  });

  it('shows the page once Try again reads /me successfully after a failure', async () => {
    mockGetMe.mockRejectedValueOnce(new Error('any failure')).mockResolvedValue(me(true));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByTestId('functional-stub')).toBeInTheDocument();
  });
});
