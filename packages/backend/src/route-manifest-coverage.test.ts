import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_MANIFEST } from '@filone/shared';
import type { Permission, RouteManifestEntry } from '@filone/shared';

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

/** A manifest value inside a regexp: `buckets.read` must not match `bucketsxread`. */
function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `authorize('buckets.read')`, however the formatter spaces it. */
function installsAuthorize(source: string, permission: Permission): boolean {
  return new RegExp(`authorize\\(\\s*['"]${literal(permission)}['"]\\s*\\)`).test(source);
}

/**
 * Whether a gate is installed and installed before the subscription guard.
 * Both `.use()` calls are in the same chain expression, so their order in the
 * file is the order the request meets them.
 */
function gateRunsFirst(source: string, gate: string): boolean {
  const gateAt = source.indexOf(`.use(${gate}`);
  const guardAt = source.indexOf('.use(subscriptionGuardMiddleware(');
  if (gateAt === -1) return false;
  return guardAt === -1 || gateAt < guardAt;
}

const byRequirement = (requires: RouteManifestEntry['requires']) =>
  ROUTE_MANIFEST.filter(
    (route) => route.category === 'authenticated' && route.requires === requires,
  );

/**
 * The gated routes with their declared permission, narrowed rather than cast:
 * the permission each route is checked for comes from the manifest entry
 * itself, so a test can never assert against a requirement the manifest does
 * not declare.
 */
const permissionGated: { handler: string; permission: Permission }[] = ROUTE_MANIFEST.filter(
  (route) => route.category === 'authenticated',
).flatMap((route) =>
  route.requires === undefined ||
  route.requires === 'self' ||
  route.requires === 'in-handler' ||
  route.requires === 'invite-token'
    ? []
    : [{ handler: route.handler, permission: route.requires }],
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
      .filter((route) => !installsAuthorize(handlerSource(route.handler), route.permission))
      .map((route) => `${route.handler} (${route.permission})`);
    expect(missing).toStrictEqual([]);
  });

  it('runs the authorization gate before the billing read on every gated route', () => {
    // Order, not just presence: a non-member must get an authorization error
    // rather than a billing error, and must not cost a BillingTable read to be
    // refused. `.use()` order is chain order, so source order is the check.
    const outOfOrder = permissionGated
      .filter((route) => !gateRunsFirst(handlerSource(route.handler), 'authorize('))
      .map((route) => route.handler);
    expect(outOfOrder).toStrictEqual([]);
  });

  it('gates the in-handler routes on membership, ahead of the billing read', () => {
    // A route whose permission depends on the body still has a requirement that
    // does not: being in the org. Left to the handler alone, this PR would ship
    // four routes a non-member reaches, and their denials would be invisible to
    // NotAMemberDenialCount.
    const ungated = byRequirement('in-handler')
      .filter(
        (route) => !gateRunsFirst(handlerSource(route.handler), 'requireMembershipMiddleware('),
      )
      .map((route) => route.handler);
    expect(ungated).toStrictEqual([]);
  });

  it('checks the in-handler routes against the same registry', () => {
    // A route whose requirement depends on the request body cannot install a
    // fixed permission, but it must still speak this registry: `authorize`'s
    // exported check is the one enforcement idiom, and a handler marked
    // in-handler that calls nothing is a route with no gate at all.
    const unchecked = byRequirement('in-handler')
      .filter((route) => !/\brequirePermission\(/.test(handlerSource(route.handler)))
      .map((route) => route.handler);
    expect(unchecked).toStrictEqual([]);
  });

  it('applies the declared cap in the handler on the routes that carry one', () => {
    // A route can hold a fixed permission in the chain and still narrow it on
    // something the chain has not read — create-access-key gates on
    // `keys.create` and caps the new key at the creator's own authority; the
    // member and invitation routes gate on `members.manage` and cap the reach
    // at the caller's own role. Both caps come from the shared registry, so a
    // route declaring one without calling it is a cap that does not run.
    const capIdiom = /\b(excessKeyPermissions|canManageTargetRole|canChangeRole)\(/;
    const uncapped = ROUTE_MANIFEST.filter((route) => route.capsInHandler)
      .filter((route) => !capIdiom.test(handlerSource(route.handler)))
      .map((route) => route.handler);
    expect(uncapped).toStrictEqual([]);
  });

  it('leaves the invite-token route without an org gate, and makes it prove the token', () => {
    // Accepting an invitation cannot ask for membership in the org it is about
    // to create one in. What replaces the gate is in the handler: the token is
    // resolved to an invitation, and the session's verified email is compared
    // with the address it was issued to.
    for (const route of byRequirement('invite-token')) {
      const source = handlerSource(route.handler);
      expect(/\b(authorize|requireMembershipMiddleware)\(/.test(source)).toBe(false);
      expect(/\bresolveInvitationByToken\(/.test(source)).toBe(true);
      expect(/\bnormalizeInviteEmail\(/.test(source)).toBe(true);
    }
  });

  it('leaves the self-service routes without an org gate of any kind', () => {
    // `self` waives the role gate AND the membership gate: changing your own
    // password or correcting your own email is not an org action, gating it on
    // a role would lock a ReadOnly member out of their own account, and gating
    // it on membership would lock out the user whose membership row is the
    // thing that went wrong.
    const gated = byRequirement('self')
      .filter((route) =>
        /\b(authorize|requireMembershipMiddleware)\(/.test(handlerSource(route.handler)),
      )
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
          !new RegExp(`cookieRequires:\\s*['"]${literal(route.cookieRequires ?? '')}['"]`).test(
            handlerSource(route.handler),
          ),
      )
      .map((route) => route.handler);
    expect(missing).toStrictEqual([]);
  });
});
