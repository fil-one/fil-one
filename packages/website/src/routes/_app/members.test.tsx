import { describe, it, expect, vi } from 'vitest';
import { isRedirect } from '@tanstack/react-router';

// The route's parent is the whole app layout, which this route never renders
// inside — it has no component, only a `beforeLoad` to call.
vi.mock('../_app', () => ({ Route: {} }));

import { Route } from './members';

/** What `beforeLoad` threw, called without the context bag this route ignores. */
function runBeforeLoad(): unknown {
  try {
    (Route.options.beforeLoad as () => void)();
  } catch (err) {
    return err;
  }
  return null;
}

// The roster is a tab of `/organization` now (FIL-1094), and this path is kept
// as a redirect for the bookmarks and links that still name it. The E2E specs
// go straight to `/organization`, so this is the only thing holding it.
describe('the /members redirect', () => {
  it('sends every caller to the Organization page, replacing the entry', () => {
    const thrown = runBeforeLoad();
    expect(isRedirect(thrown)).toBe(true);

    // Both of the options this route states. `statusCode` is `redirect()`'s own
    // default and would be asserting the router rather than the route.
    const { to, replace } = (thrown as { options: { to?: string; replace?: boolean } }).options;
    expect({ to, replace }).toEqual({ to: '/organization', replace: true });
  });
});
