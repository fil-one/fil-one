import { describe, it, expect, vi } from 'vitest';

vi.mock('../_app', () => ({ Route: {} }));

import { Route as aiAgentToolkitRoute } from './ai-agent-toolkit';
import { Route as bucketIntelligenceRoute } from './bucket-intelligence';

type BeforeLoad = () => unknown;

function thrownBy(route: typeof aiAgentToolkitRoute | typeof bucketIntelligenceRoute): unknown {
  try {
    // `beforeLoad` is typed to take the router's full context, which these
    // routes never read, so it is called here with none.
    (route.options.beforeLoad as unknown as BeforeLoad)();
  } catch (err) {
    return err;
  }
  return undefined;
}

// Both pages are gone, but their paths are in bookmarks and emailed links.
describe('the retired AI Tools URLs', () => {
  it.each([
    ['/ai-agent-toolkit', aiAgentToolkitRoute],
    ['/bucket-intelligence', bucketIntelligenceRoute],
  ])('sends %s to the dashboard, replacing the history entry', (_path, route) => {
    expect(thrownBy(route)).toMatchObject({
      status: 307,
      options: { to: '/dashboard', replace: true },
    });
  });
});
