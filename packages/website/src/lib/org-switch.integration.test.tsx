import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * An org switch driven through the real router, with only the network faked.
 *
 * `switchToOrg` holds every `apiRequest` until its own navigation settles, and
 * that navigation runs `_app`'s `beforeLoad`, which reads `/me`. If that read
 * waited on the latch, the switch would never finish.
 * A unit test that stubs the router cannot see which routes opt out, so this
 * one goes through the route tree the app actually ships.
 */

// Pulled in by the route tree; analytics has no part in a switch.
vi.mock('../plausible.js', () => ({ track: vi.fn() }));

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function urlOf(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

function meFor(orgId: string) {
  return {
    orgId,
    orgName: orgId === ORG_A ? 'Acme' : 'Globex',
    nameConfirmed: true,
    emailVerified: true,
    role: 'owner',
    permissions: [],
    memberships: [
      { orgId: ORG_A, orgName: 'Acme', role: 'owner' },
      { orgId: ORG_B, orgName: 'Globex', role: 'owner' },
    ],
  };
}

type RouterModule = typeof import('../router.js');
type ActiveOrgModule = typeof import('./active-org.js');

describe('switching orgs through the real router', () => {
  let router: RouterModule['router'];
  let activeOrg: ActiveOrgModule;

  // The route tree is the whole console, so loading it cold can outlast a
  // single test's budget on a busy runner. Loaded once, up front, on its own.
  beforeAll(async () => {
    ({ router } = await import('../router.js'));
    activeOrg = await import('./active-org.js');
  }, 30_000);

  beforeEach(() => {
    document.cookie = 'hs_logged_in=1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        const orgId = new Headers(init?.headers).get('X-Org-Id') ?? ORG_A;
        const body = url.includes('/me') ? meFor(orgId) : {};
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.unstubAllGlobals();
    document.cookie = 'hs_logged_in=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });

  it('settles the switch and lands on the dashboard, answered for the target org', async () => {
    const { getActiveOrgId, isSwitchingOrg, switchToOrg } = activeOrg;
    await router.navigate({ to: '/dashboard' });

    switchToOrg(ORG_B);

    await vi.waitFor(() => expect(isSwitchingOrg()).toBe(false), { timeout: 3000 });
    // The URL carries no org: the tab's own choice does, on every request.
    expect(router.state.location.pathname).toBe('/dashboard');
    expect(getActiveOrgId()).toBe(ORG_B);
    const meOrgs = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => urlOf(input).includes('/me'))
      .map(([, init]) => new Headers(init?.headers).get('X-Org-Id'));
    expect(meOrgs).toContain(ORG_B);
  });
});
