import { describe, it, expect, vi } from 'vitest';
import { isRedirect } from '@tanstack/react-router';

vi.mock('../_app', () => ({ Route: {} }));

import { Route as aiAgentToolkitRoute } from './ai-agent-toolkit';
import { Route as bucketIntelligenceRoute } from './bucket-intelligence';

type BeforeLoad = () => unknown;

function redirectFor(route: typeof aiAgentToolkitRoute | typeof bucketIntelligenceRoute) {
  let thrown: unknown;
  try {
    // `beforeLoad` is typed to take the router's full context, which these
    // routes never read, so it is called here with none.
    (route.options.beforeLoad as unknown as BeforeLoad)();
  } catch (err) {
    thrown = err;
  }
  expect(isRedirect(thrown)).toBe(true);
  const { to, replace } = (thrown as { options: { to?: string; replace?: boolean } }).options;
  return { to, replace };
}

// Both pages are gone, but their paths are in bookmarks and emailed links.
describe('the retired AI Tools URLs', () => {
  it.each([
    ['/ai-agent-toolkit', aiAgentToolkitRoute],
    ['/bucket-intelligence', bucketIntelligenceRoute],
  ])('sends %s to the dashboard, replacing the history entry', (_path, route) => {
    expect(redirectFor(route)).toStrictEqual({ to: '/dashboard', replace: true });
  });
});
