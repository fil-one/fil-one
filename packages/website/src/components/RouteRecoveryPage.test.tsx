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

  it('leaves page chrome to AppShell when a route errors', () => {
    render(
      <RouteErrorPage error={new Error('internal diagnostic')} reset={vi.fn()} info={undefined} />,
    );

    expect(screen.queryByRole('img', { name: 'Fil One' })).not.toBeInTheDocument();
  });

  it('gives unknown routes reload and dashboard recovery on its own page', () => {
    render(<RouteNotFoundPage />);

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload page' })).toHaveClass('button--primary');
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(screen.getByRole('img', { name: 'Fil One' })).toBeInTheDocument();
  });
});
