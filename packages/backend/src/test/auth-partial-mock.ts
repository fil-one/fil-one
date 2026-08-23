/**
 * The `../middleware/auth.js` stub every handler test that skips authentication
 * uses:
 *
 * ```ts
 * vi.mock('../middleware/auth.js', () => authPartialMock());
 * ```
 *
 * A `vi.mock` factory replaces the whole module, so the stub has to supply every
 * export a handler chain reaches, not just `authMiddleware`: a handler that wraps
 * its response through `withRefreshedCookies` gets `undefined` and throws when the
 * stub leaves it out. Keeping both here means a new auth export is one edit rather
 * than one per test file.
 *
 * Its own file, and deliberately importing nothing: `vi.mock` factories are
 * hoisted above the imports, so a factory reaching a module that itself imports
 * the mocked module reads that binding before it is initialized. A leaf module
 * cannot.
 */
export function authPartialMock(): {
  withRefreshedCookies: (request: unknown, response: unknown) => unknown;
  authMiddleware: () => { before: () => undefined };
} {
  return {
    withRefreshedCookies: (_request: unknown, response: unknown) => response,
    authMiddleware: () => ({ before: () => undefined }),
  };
}
