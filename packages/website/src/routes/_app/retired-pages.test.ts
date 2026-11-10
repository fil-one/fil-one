import { describe, it, expect, vi } from 'vitest';

vi.mock('../_app', () => ({ Route: {} }));

import { Route as aiAgentToolkitRoute } from './ai-agent-toolkit';

type BeforeLoad = () => unknown;

function thrownBy(route: typeof aiAgentToolkitRoute): unknown {
  try {
    // `beforeLoad` is typed to take the router's full context, which this
    // route never reads, so it is called here with none.
    (route.options.beforeLoad as unknown as BeforeLoad)();
  } catch (err) {
    return err;
  }
  return undefined;
}

// The page is gone, but its path is in bookmarks and emailed links.
describe('the retired AI Agent Toolkit URL', () => {
  it('sends /ai-agent-toolkit to the dashboard, replacing the history entry', () => {
    expect(thrownBy(aiAgentToolkitRoute)).toMatchObject({
      status: 307,
      options: { to: '/dashboard', replace: true },
    });
  });
});
