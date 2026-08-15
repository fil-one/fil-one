import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_MANIFEST } from '@filone/shared';
import type { RouteManifestEntry } from '@filone/shared';

/**
 * The manifest's completeness check, which only the backend can make: the
 * shared package declares every route and what it requires, and this test is
 * what stops that declaration from drifting away from the handlers it
 * describes. A new route with no manifest entry is a red build rather than an
 * ungated endpoint nobody notices.
 *
 * Both halves matter. The first is coverage — every handler module is named by
 * the manifest and every manifest entry names a real module. The second is
 * enforcement — a route the manifest gates on a permission actually installs
 * `authorize` for that permission, and a route marked `self` installs no
 * org-permission gate at all.
 *
 * The enforcement half reads the handler's source rather than importing it:
 * every handler module builds its DynamoDB client and reads SST resources at
 * import time, so importing all of them here would test the mocking setup
 * rather than the chains. The repository formats with oxfmt, so the call it
 * looks for has one spelling.
 */

const HANDLERS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'handlers');

function handlerModules(): string[] {
  return readdirSync(HANDLERS_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => file.replace(/\.ts$/, ''))
    .sort();
}

function handlerSource(handler: string): string {
  return readFileSync(path.join(HANDLERS_DIR, `${handler}.ts`), 'utf8');
}

/** `authorize('buckets.read')`, however the formatter spaces it. */
function installsAuthorize(source: string, permission: string): boolean {
  return new RegExp(`authorize\\(\\s*['"]${permission}['"]\\s*\\)`).test(source);
}

const byRequirement = (requires: RouteManifestEntry['requires']) =>
  ROUTE_MANIFEST.filter(
    (route) => route.category === 'authenticated' && route.requires === requires,
  );

const permissionGated = ROUTE_MANIFEST.filter(
  (route) =>
    route.category === 'authenticated' &&
    route.requires !== undefined &&
    route.requires !== 'self' &&
    route.requires !== 'in-handler',
);

describe('route manifest coverage', () => {
  it('names every handler module in packages/backend/src/handlers', () => {
    const declared = ROUTE_MANIFEST.map((route) => route.handler).sort();
    // Fails in both directions on purpose: a handler with no entry is an
    // ungated route, and an entry with no handler is a stale declaration that
    // would make the checks below vacuously pass.
    expect(declared).toStrictEqual(handlerModules());
  });

  it('installs authorize with the declared permission on every gated route', () => {
    const missing = permissionGated
      .filter((route) => !installsAuthorize(handlerSource(route.handler), route.requires as string))
      .map((route) => `${route.handler} (${route.requires})`);
    expect(missing).toStrictEqual([]);
  });

  it('leaves the self-service routes without an org-permission gate', () => {
    // `self` means membership in the active org is the whole requirement:
    // changing your own password or unenrolling your own authenticator is not
    // an org action, and gating it on a role would lock a ReadOnly member out
    // of their own account.
    const gated = byRequirement('self')
      .filter((route) => /\bauthorize\(/.test(handlerSource(route.handler)))
      .map((route) => route.handler);
    expect(gated).toStrictEqual([]);
  });

  it('leaves the routes that bypass the cookie session without an authorize call', () => {
    const gated = ROUTE_MANIFEST.filter(
      (route) => route.category === 'public' || route.category === 'webhook',
    )
      .filter((route) => /\bauthorize\(/.test(handlerSource(route.handler)))
      .map((route) => route.handler);
    expect(gated).toStrictEqual([]);
  });

  it('passes the declared cookie requirement into the bearer routes', () => {
    const missing = ROUTE_MANIFEST.filter((route) => route.category === 'bearer')
      .filter(
        (route) =>
          !new RegExp(`cookieRequires:\\s*['"]${route.cookieRequires}['"]`).test(
            handlerSource(route.handler),
          ),
      )
      .map((route) => route.handler);
    expect(missing).toStrictEqual([]);
  });
});
