import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedirect, isNotFound } from '@tanstack/react-router';
import { OrgRole } from '@filone/shared';
import type { MeResponse } from '@filone/shared';

// The route's parent is the whole app layout, which this route never renders
// inside — it has no component, only a `beforeLoad` to call.
vi.mock('../_app', () => ({ Route: {} }));
vi.mock('../../lib/api.js', () => ({ getMe: vi.fn() }));

import { Route } from './members';
import { getMe } from '../../lib/api.js';
import { queryClient } from '../../lib/query-client.js';

/** What `beforeLoad` threw, awaited past the async `/me` read it now does. */
function runBeforeLoad(): Promise<unknown> {
  return (Route.options.beforeLoad as () => Promise<void>)().catch((err: unknown) => err);
}

// The roster is a tab of `/organization` now (FIL-1094), and this path is kept
// as a redirect for the bookmarks and links that still name it. The E2E specs
// go straight to `/organization`, so this is the only thing holding it.
describe('the /members redirect', () => {
  beforeEach(() => {
    queryClient.clear();
    vi.mocked(getMe).mockReset();
  });

  it('sends the caller to their active org’s Organization page, replacing the entry', async () => {
    vi.mocked(getMe).mockResolvedValue({
      orgId: 'org-1',
      memberships: [{ orgId: 'org-1', orgName: 'Acme', role: OrgRole.Owner, slug: 'acme' }],
    } as unknown as MeResponse);

    const thrown = await runBeforeLoad();
    expect(isRedirect(thrown)).toBe(true);

    const { href, replace } = (thrown as { options: { href?: string; replace?: boolean } }).options;
    expect({ href, replace }).toEqual({ href: '/acme/organization', replace: true });
  });

  it('is a not-found for a caller with no resolvable org', async () => {
    vi.mocked(getMe).mockResolvedValue({
      orgId: 'org-1',
      memberships: [],
    } as unknown as MeResponse);

    const thrown = await runBeforeLoad();
    expect(isNotFound(thrown)).toBe(true);
  });
});
