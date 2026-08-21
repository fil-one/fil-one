import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RouteErrorPage, RouteNotFoundPage } from './RouteRecoveryPage.js';

describe('route recovery pages', () => {
  it('offers safe recovery actions for an unexpected error', () => {
    render(
      <RouteErrorPage error={new Error('internal diagnostic')} reset={vi.fn()} info={undefined} />,
    );

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload page' })).toHaveClass('button--primary');
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(screen.getByText('Technical details')).toBeInTheDocument();
    expect(screen.getByText('internal diagnostic')).not.toBeVisible();
    expect(
      screen.queryByText(/stored data|data (?:was|has been) unchanged/i),
    ).not.toBeInTheDocument();
  });

  it('renders as a card inside AppShell chrome, not a full-screen ground, when a route errors', () => {
    const { container } = render(
      <RouteErrorPage error={new Error('internal diagnostic')} reset={vi.fn()} info={undefined} />,
    );

    // The full-screen ground belongs to the standalone recovery/auth cards;
    // the in-AppShell error card must not take over the viewport.
    expect(container.querySelector('.min-h-screen')).toBeNull();
    // It still carries the lockup so the card reads as a deliberate surface.
    expect(screen.getByRole('img', { name: 'Fil One' })).toBeInTheDocument();
  });

  it('gives unknown routes a way back on its own standalone page', () => {
    const { container } = render(<RouteNotFoundPage />);

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    // Reload is pointless on a 404 (it just 404s again), so the only action is a way back.
    expect(screen.queryByRole('button', { name: 'Reload page' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(screen.getByRole('img', { name: 'Fil One' })).toBeInTheDocument();
    // Standalone: it supplies its own full-screen ground (no AppShell around it).
    expect(container.querySelector('.min-h-screen')).not.toBeNull();
  });
});
