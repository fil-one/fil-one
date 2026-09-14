import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { OnboardingPage } from './OnboardingPage.js';

// ---------------------------------------------------------------------------
// Mocks — router
// ---------------------------------------------------------------------------

vi.mock('@tanstack/react-router', () => ({
  // `params`/`search` are router-only props — dropping them keeps them off the DOM.
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  // `useOrgSlug`/`BaseLink` read the active org's slug through this; no org
  // context here, so `orgSlug` comes back empty and paths render unprefixed.
  useParams: () => ({}),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OnboardingPage', () => {
  it('offers creating a bucket and an API key, before either exists', () => {
    render(<OnboardingPage />);

    const bucketLink = screen.getByRole('link', { name: 'Create bucket' });
    expect(bucketLink).toHaveAttribute('href', '/buckets/create');

    const keyLink = screen.getByRole('link', { name: 'Create API key' });
    expect(keyLink).toHaveAttribute('href', '/api-keys/create');
  });

  it('names each action "another" once the account already holds one', () => {
    render(<OnboardingPage hasBucket hasKey />);

    expect(screen.getByRole('link', { name: 'Create another bucket' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create another key' })).toBeInTheDocument();
  });

  it('offers the explore-more paths as their own next steps', () => {
    render(<OnboardingPage />);

    expect(screen.getByRole('link', { name: 'Invite people' })).toHaveAttribute(
      'href',
      '/members?tab=invitations',
    );
    expect(screen.getByRole('link', { name: 'Explore the documentation' })).toHaveAttribute(
      'href',
      'https://docs.fil.one',
    );
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute(
      'href',
      '/support',
    );
  });
});
