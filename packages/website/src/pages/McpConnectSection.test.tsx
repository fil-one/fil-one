import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { McpConnectSection } from './McpConnectSection.js';
import { ToastProvider } from '../components/Toast/ToastProvider.js';

/** CopyButton reports through a toast, so the section renders inside its provider. */
function renderSection() {
  return render(
    <ToastProvider>
      <McpConnectSection />
    </ToastProvider>,
  );
}

describe('McpConnectSection', () => {
  // The AI agents page titles itself with an h1, so the section comes next.
  it('heads the section at level 2', () => {
    renderSection();

    expect(
      screen.getByRole('heading', { level: 2, name: 'Connect an agent with MCP' }),
    ).toBeVisible();
  });

  it('offers each agent as a tab', () => {
    renderSection();

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toStrictEqual([
      'Claude Code',
      'Claude',
      'Codex',
      'VS Code',
    ]);
  });

  it('shows this console’s MCP server URL and fills it into the first agent’s command', () => {
    renderSection();

    const url = `${window.location.origin}/api/mcp`;
    expect(screen.getByText(url)).toBeVisible();
    expect(screen.getByText(`claude mcp add --transport http filone ${url}`)).toBeVisible();
  });
});
