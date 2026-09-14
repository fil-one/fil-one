import { useParams } from '@tanstack/react-router';

/**
 * `useParams` (via `useMatch`) throws outside a mounted router rather than
 * returning an empty result — unlike `useRouter`, which just warns. A great
 * many small presentational components reach this indirectly through
 * `BaseLink`/`Button`/`Link` and are unit-tested with no router at all (no
 * `RouterProvider`, no mocked `@tanstack/react-router`), so this reads as a
 * genuine "no org context" case rather than a bug: same outcome as any other
 * page reached before `$orgSlug` — an unprefixed path.
 */
function orgSlugParam(): string | undefined {
  try {
    return useParams({ strict: false }).orgSlug;
  } catch {
    return undefined;
  }
}

/**
 * Paths that live outside `$orgSlug`, reached before an org context exists at
 * all: signing in, verifying an email, accepting an invite, or naming the org
 * on `/create-organization` (before that org's slug is worth putting in a URL
 * for a caller who hasn't seen it yet). `/welcome` is the old name for that
 * same step, still here as the redirect stub that keeps it working.
 * `/get-started` is NOT here — the org already has a slug by then, same as
 * every other real page. `prefixWithOrg` leaves these exactly as written
 * rather than stapling a slug onto them.
 */
const UNSCOPED_PATHS = new Set([
  '/',
  '/login',
  '/login-error',
  '/sign-in',
  '/sign-up',
  '/verify-email',
  '/create-organization',
  '/welcome',
  '/left-organization',
  '/invite/accept',
  '/account-deleted',
]);

function pathname(path: string): string {
  const end = path.search(/[?#]/);
  return end === -1 ? path : path.slice(0, end);
}

/**
 * Prefix an internal path with the active org's slug, unless it names one of
 * the unscoped routes above or there is no slug to prefix with (outside
 * `$orgSlug` entirely — the auth pages, mainly).
 *
 * `path` may carry a search string or hash; only the pathname in front of
 * those is checked against the allowlist and prefixed.
 */
export function prefixWithOrg(path: string, orgSlug: string | undefined): string {
  if (!orgSlug) return path;
  if (!path.startsWith('/')) return path;
  if (UNSCOPED_PATHS.has(pathname(path))) return path;
  return `/${orgSlug}${path}`;
}

/**
 * Reads the current `orgSlug` route param and returns a prefixer for internal
 * paths — the piece `BaseLink` uses so every plain `href="/buckets"` in the
 * app lands on the active org's `/buckets` without each call site naming the
 * org itself.
 */
export function useOrgPath(): (path: string) => string {
  const orgSlug = orgSlugParam();
  return (path: string) => prefixWithOrg(path, orgSlug);
}

/**
 * The active org's slug, for the call sites that navigate with TanStack
 * Router's own typed `to`/`params` (bypassing `BaseLink`, which is what needs
 * the string-prefixing `useOrgPath` does) and so have to name `$orgSlug`
 * themselves in both places.
 *
 * Every real page in the console renders under `$orgSlug`, so this is always
 * populated there; the empty-string fallback only matters if one of these
 * components is ever rendered outside that context, where it reads as a loud
 * broken link rather than a silent departure from the caller's active org.
 */
export function useOrgSlug(): string {
  return orgSlugParam() ?? '';
}
