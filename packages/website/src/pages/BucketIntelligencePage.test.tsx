import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MeResponse } from '@filone/shared';

// Stub the two branches so this test targets the ragAccess routing only — not
// the functional page's data deps or the waitlist's full marketing markup.
vi.mock('./RagPipelinePage.js', () => ({
  RagPipelinePage: () => <div data-testid="functional-stub" />,
}));
vi.mock('../components/ComingSoonPage.js', () => ({
  ComingSoonPage: () => <div data-testid="waitlist-stub" />,
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
    emailVerified: true,
    email: 'user@example.com',
    name: 'User',
    mfaEnrollments: [],
    ragAccess,
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
    expect(screen.queryByTestId('waitlist-stub')).not.toBeInTheDocument();
  });

  it('renders the waitlist for non-allowlisted users', async () => {
    mockGetMe.mockResolvedValue(me(false));
    renderPage();

    expect(await screen.findByTestId('waitlist-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('functional-stub')).not.toBeInTheDocument();
  });

  it('shows neither branch while /me is loading (no waitlist flash)', () => {
    // Never resolves — keeps the query pending.
    mockGetMe.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('waitlist-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('functional-stub')).not.toBeInTheDocument();
  });
});
