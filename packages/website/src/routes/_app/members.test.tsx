import { describe, it, expect, vi } from 'vitest';
import { isRedirect } from '@tanstack/react-router';

// The route's parent is the whole app layout, which this route never renders
// inside — it has no component, only a `beforeLoad` to call.
vi.mock('../_app', () => ({ Route: {} }));

import { Route } from './members';

// The roster is a tab of `/organization` now (FIL-1094), and this path is kept
// as a redirect for the bookmarks and links that still name it. The E2E specs
// go straight to `/organization`, so this is the only thing holding it.
describe('/members', () => {
  it('sends every caller to the Organization page, replacing the entry', () => {
    let thrown: unknown;
    try {
      (Route.options.beforeLoad as () => void)();
    } catch (err) {
      thrown = err;
    }

    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: Record<string, unknown> }).options).toEqual({
      to: '/organization',
      replace: true,
      statusCode: 307,
    });
  });
});
