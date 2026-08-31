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
  getVerifiedIdTokenClaims: () => IdTokenClaims;
} {
  return {
    withRefreshedCookies: (_request: unknown, response: unknown) => response,
    authMiddleware: () => ({ before: () => undefined }),
    // The same empty claims the real export hands back when no valid id_token
    // cookie was present. `amr: []` fails the step-up gate closed, so a chain
    // carrying `requireMfa()` answers its 401 rather than throwing on an
    // export the stub forgot.
    getVerifiedIdTokenClaims: () => ({
      email: null,
      emailVerified: false,
      name: null,
      picture: null,
      amr: [],
    }),
  };
}

/** Mirrors `IdTokenClaims` in ../middleware/auth.js, which this file cannot import. */
interface IdTokenClaims {
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  amr: string[];
}
