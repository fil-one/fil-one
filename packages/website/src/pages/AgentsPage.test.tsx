import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The API keys link is the router's; a plain anchor stands in for it here.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

import { AgentsPage } from './AgentsPage.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';

function renderPage() {
  return render(
    <ToastProvider>
      <AgentsPage />
    </ToastProvider>,
  );
}

describe('AgentsPage', () => {
  it('titles the page AI agents and shows how to connect one with MCP', () => {
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'AI agents' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Connect an agent with MCP' })).toBeVisible();
  });

  it('points to API keys for an agent that works with a scoped key instead', () => {
    renderPage();

    expect(screen.getByRole('link', { name: 'API keys' })).toHaveAttribute('href', '/api-keys');
  });
});
