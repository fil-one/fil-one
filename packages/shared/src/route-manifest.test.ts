import { describe, it, expect } from 'vitest';
import { PERMISSIONS } from './permissions.js';
import { ROUTE_MANIFEST } from './route-manifest.js';
import type { RouteManifestEntry } from './route-manifest.js';

const entries = ROUTE_MANIFEST;

describe('ROUTE_MANIFEST', () => {
  it('lists every registered route once', () => {
    // Completeness is the backend's manifest coverage test, which walks
    // src/handlers/. What this adds is uniqueness: two entries for one method
    // and path would let a route be declared twice with different requirements.
    const keys = entries.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('names each handler once', () => {
    const handlers = entries.map((route) => route.handler);
    expect(new Set(handlers).size).toBe(handlers.length);
  });

  it('gives every authenticated route a requirement', () => {
    const ungated = entries
      .filter((route) => route.category === 'authenticated' && route.requires === undefined)
      .map((route) => route.handler);
    expect(ungated).toStrictEqual([]);
  });

  it('leaves the routes that bypass the cookie session without a role gate', () => {
    const misdeclared = entries
      .filter((route) => route.category !== 'authenticated' && route.requires !== undefined)
      .map((route) => route.handler);
    expect(misdeclared).toStrictEqual([]);
  });

  it('gives the cookie fallback a requirement on bearer routes and nowhere else', () => {
    // A bearer token carries its own authority; the cookie caller on the same
    // route is an ordinary console user and needs a permission.
    const withCookieGate = entries
      .filter((route) => route.cookieRequires !== undefined)
      .map((route) => route.handler);
    expect(withCookieGate).toStrictEqual(['query-bucket']);

    const bearerWithoutCookieGate = entries
      .filter((route) => route.category === 'bearer' && route.cookieRequires === undefined)
      .map((route) => route.handler);
    expect(bearerWithoutCookieGate).toStrictEqual([]);
  });

  it('requires only declared permissions or the in-registry markers', () => {
    const allowed = new Set<string>([...PERMISSIONS, 'self', 'in-handler', 'invite-token']);
    for (const route of entries) {
      if (route.requires !== undefined) {
        expect(allowed.has(route.requires)).toBe(true);
      }
      if (route.cookieRequires !== undefined) {
        expect(new Set<string>(PERMISSIONS).has(route.cookieRequires)).toBe(true);
      }
    }
  });

  it('categorizes the routes that bypass the cookie session', () => {
    const byCategory = (category: RouteManifestEntry['category']) =>
      entries.filter((route) => route.category === category).map((route) => route.handler);

    expect(byCategory('public')).toStrictEqual(['auth-login', 'auth-callback', 'auth-logout']);
    expect(byCategory('webhook')).toStrictEqual(['stripe-webhook']);
    expect(byCategory('bearer')).toStrictEqual(['query-bucket']);
  });

  it('checks the routes whose requirement depends on the request in their handlers', () => {
    // presign serves seven operations through one route, and
    // set-bucket-rag-enablement creates or discards an index depending on the
    // flag. Neither has a permission the chain could name.
    const inHandler = entries
      .filter((route) => route.requires === 'in-handler')
      .map((route) => route.handler);
    expect(inHandler.sort()).toStrictEqual(['presign', 'set-bucket-rag-enablement']);
  });

  it('names a declared permission alongside every in-handler cap', () => {
    // A cap narrows a requirement; it does not replace one. create-access-key
    // gates on `keys.create` in the chain and caps the new key at the creator's
    // own authority in the handler; the member and invitation routes gate on
    // `members.manage` and cap the reach at the caller's own role. The manifest
    // states both halves in each case.
    const capped = entries.filter((route) => route.capsInHandler);
    expect(capped.map((route) => route.handler)).toStrictEqual([
      'create-access-key',
      'update-member-role',
      'remove-member',
      'get-role-change-preview',
      'create-invitation',
      'revoke-invitation',
    ]);
    for (const route of capped) {
      expect(new Set<string>(PERMISSIONS).has(route.requires as string)).toBe(true);
    }
  });

  it('keeps the self-service marker on the caller-only routes', () => {
    // 'self' waives the org gate entirely, so it must never reach a route that
    // touches org state: every route carrying it is /api/me itself or lives
    // under /api/me/ or /api/mfa/. Matching the bare prefix would let
    // /api/members through.
    const isSelfServicePath = (path: string) =>
      path === '/api/me' || path.startsWith('/api/me/') || path.startsWith('/api/mfa/');
    const offOrg = entries
      .filter((route) => route.requires === 'self')
      .filter((route) => !isSelfServicePath(route.path))
      .map((route) => route.path);
    expect(offOrg).toStrictEqual([]);
  });

  it('reserves the invite-token requirement for accepting an invitation', () => {
    // One route, and it must stay one: the requirement waives the org gate for
    // a caller who is not a member yet, so anything else carrying it would be
    // an org route with no gate at all.
    const tokenGated = entries.filter((route) => route.requires === 'invite-token');

    expect(tokenGated.map((route) => route.handler)).toStrictEqual(['accept-invitation']);
    expect(tokenGated[0].category).toBe('authenticated');
  });
});
