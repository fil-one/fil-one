import { describe, it, expect } from 'vitest';
import { PERMISSIONS } from './permissions.js';
import { ROUTE_MANIFEST } from './route-manifest.js';
import type { RouteManifestEntry } from './route-manifest.js';

const entries: readonly RouteManifestEntry[] = ROUTE_MANIFEST;

describe('ROUTE_MANIFEST', () => {
  it('lists every registered route once', () => {
    // 38 routes are registered via addRoute in sst.config.ts. The backend's
    // completeness test walks src/handlers/; this pins the count so a route
    // added to the config without a manifest entry is visible here too.
    expect(entries).toHaveLength(38);
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

  it('leaves public, webhook, and bearer routes without a requirement', () => {
    const misdeclared = entries
      .filter((route) => route.category !== 'authenticated' && route.requires !== undefined)
      .map((route) => route.handler);
    expect(misdeclared).toStrictEqual([]);
  });

  it('requires only declared permissions or the two in-registry markers', () => {
    const allowed = new Set<string>([...PERMISSIONS, 'self', 'in-handler']);
    for (const route of entries) {
      if (route.requires !== undefined) {
        expect(allowed.has(route.requires)).toBe(true);
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

  it('checks the multi-operation routes in their handlers', () => {
    // presign serves read/write/delete through one route; update-profile can
    // rename the org. Both requirements depend on the request body.
    const inHandler = entries
      .filter((route) => route.requires === 'in-handler')
      .map((route) => route.handler);
    expect(inHandler.sort()).toStrictEqual(['presign', 'update-profile']);
  });

  it('keeps the self-service marker on the caller-only routes', () => {
    // 'self' waives the role gate, so it must never reach a route that touches
    // org state: every route carrying it lives under /api/me or /api/mfa.
    const offOrg = entries
      .filter((route) => route.requires === 'self')
      .filter((route) => !route.path.startsWith('/api/me') && !route.path.startsWith('/api/mfa'))
      .map((route) => route.path);
    expect(offOrg).toStrictEqual([]);
  });
});
