import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiErrorCode, type OrgRole, type S3Region } from '@filone/shared';

export const ME_STALE_TIME = 10 * 60_000;

// Usage counters are daily-resolution upstream, and every usage-changing
// mutation invalidates the ['usage'] key prefix — so a staleTime only trims
// redundant refetches on remount/refocus, never delays user-triggered updates.
export const USAGE_STALE_TIME = 5 * 60_000;

// Tuning for the list pages a user returns to often (buckets, access keys).
//
// gcTime well past the default 5 min keeps a list a user already loaded this
// session in cache, so returning to it paints instantly instead of showing a
// cold spinner (the "5-minute cliff"). Keeping data longer is never a freshness
// cost: a remount past staleTime still refetches. A short staleTime then trims
// redundant background refetches on rapid back-and-forth. Both are safe against
// the user's own edits because the mutations invalidate their query keys, which
// overrides staleTime and forces an immediate refetch.
export const LIST_STALE_TIME = 30_000;
export const LIST_GC_TIME = 30 * 60_000;

// 410 included: the account is gone, so a retry can only fail again. apiRequest
// throwing is not enough on its own — only this set stops the retry.
const NO_RETRY_STATUSES = new Set([401, 403, 410]);

export function defaultRetry(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status !== undefined && NO_RETRY_STATUSES.has(status)) return false;
  return failureCount < 1;
}

/**
 * Whether an error is one of the two role denials.
 *
 * `ForbiddenRoleError` and `NotAMemberError` both carry their API code, and the
 * fix for either is the same: the console's picture of the caller's role is out
 * of date, so re-read `/me`. Retrying the request would only earn the same 403.
 * The codes are matched rather than the classes so this file stays independent
 * of `api.ts`.
 */
export function isRoleDenial(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === ApiErrorCode.FORBIDDEN_ROLE || code === ApiErrorCode.NOT_A_MEMBER;
}

/**
 * Whether the account or the org behind this request is gone.
 *
 * The backend sends this while an account deletion is running, and it reaches
 * ordinary requests first: `api.ts` navigates to `/account-deleted` only when
 * the session probe reports it, so an org another Owner has started deleting
 * takes every panel down while `/me` sits fresh for its ten minutes and the
 * console keeps rendering a session that has ended.
 */
export function isAccountDeleted(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === ApiErrorCode.ACCOUNT_DELETED;
}

/**
 * Re-read `/me` when a request says the console's picture of the session is out
 * of date.
 *
 * A role denial means the server and the console disagree about what the caller
 * may do — a role changed under an open tab, or a control was left ungated. A
 * deleted account means there is no session left to render at all. `/me` is the
 * console's only source for either answer, so it gets re-read; the failed
 * request is not retried. The `/me` that comes back carries the deletion itself,
 * and that one navigates.
 *
 * A failure on `/me` itself is exempt: invalidating the query that just failed
 * would refetch it, fail again, and loop.
 */
function refreshSessionOnDenial(error: unknown, queryKey?: readonly unknown[]): void {
  if (!isRoleDenial(error) && !isAccountDeleted(error)) return;
  if (queryKey?.[0] === 'me') return;
  void queryClient.invalidateQueries({ queryKey: ['me'] });
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => refreshSessionOnDenial(error, query.queryKey),
  }),
  mutationCache: new MutationCache({
    onError: (error) => refreshSessionOnDenial(error),
  }),
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: 5 * 60_000,
      retry: defaultRetry,
    },
  },
});

/** The prefix every preview shares, so one invalidation reaches them all. */
const ROLE_CHANGE_PREVIEWS = ['role-change-preview'] as const;

export const queryKeys = {
  me: ['me'] as const,
  meWithMfa: ['me', 'mfa'] as const,
  usage: ['usage'] as const,
  billing: ['billing'] as const,
  invoices: ['invoices'] as const,
  activityRecent: (limit: number) => ['activity', 'recent', limit] as const,
  // Shares the ['usage'] prefix so invalidateQueries({ queryKey: queryKeys.usage })
  // also invalidates the trends charts.
  usageTrends: (period: '7d' | '30d') => ['usage', 'trends', period] as const,
  buckets: ['buckets'] as const,
  // Shares the ['buckets'] prefix so deleting a bucket invalidates both the
  // unfiltered baseline and whatever filtered/sorted view is active.
  bucketsFiltered: (params: Record<string, string>) => ['buckets', 'filtered', params] as const,
  bucket: (bucketName: string, region: S3Region) => ['bucket', bucketName, region] as const,
  objects: (bucketName: string, region: S3Region) => ['objects', bucketName, region] as const,
  objectMetadata: (bucketName: string, objectKey: string, versionId?: string) =>
    ['object-metadata', bucketName, objectKey, ...(versionId ? [versionId] : [])] as const,
  // ['access-keys'] is the prefix — invalidateQueries on this key also invalidates
  // all bucket-scoped access key queries (prefix match).
  accessKeys: ['access-keys'] as const,
  bucketAccessKeys: (bucketName: string, region: S3Region) =>
    ['access-keys', bucketName, region] as const,
  bucketAnalytics: (bucketName: string, region: S3Region) =>
    ['bucket-analytics', bucketName, region] as const,
  // The org's roster and its outstanding invitations. Two keys rather than one:
  // every role may read the members list, while the invitations list is
  // `members.manage`, so a single key would tie a query most callers can run to
  // one most callers cannot.
  members: ['members'] as const,
  // Its own prefix rather than under ['members']: the roster is invalidated on
  // every change, and a preview of what a change would revoke is about a role
  // nobody holds yet, so refetching it after the change asks a stale question.
  roleChangePreviews: ROLE_CHANGE_PREVIEWS,
  roleChangePreview: (userId: string, role: OrgRole) =>
    [...ROLE_CHANGE_PREVIEWS, userId, role] as const,
  invitations: ['invitations'] as const,
  // Prefixed, so invalidating ['audit'] clears every filter combination a
  // session has looked at rather than just the one on screen.
  auditEvents: (params: string) => ['audit', 'events', params] as const,
  instatusSummary: ['instatus-summary'] as const,
  preferences: ['preferences'] as const,
  // RAG Pipeline (FIL-555). Distinct from `buckets` so the RAG surface can be
  // refetched/invalidated independently of the storage buckets list.
  ragBuckets: ['rag-buckets'] as const,
  // ['rag-bucket-enabled'] is the prefix — invalidateQueries on this key also
  // invalidates all per-bucket enablement queries (prefix match).
  ragBucketEnabled: ['rag-bucket-enabled'] as const,
  ragBucketEnabledFor: (bucketName: string, region: S3Region) =>
    ['rag-bucket-enabled', bucketName, region] as const,
  // RAG API keys (query-endpoint bearer tokens) — distinct from `accessKeys`.
  ragApiKeys: ['rag-api-keys'] as const,
};

/**
 * `/me` is rate-limited at the key, not at each hook.
 *
 * Five surfaces observe `['me']` — the permission hook, the sidebar, the mobile
 * user menu, the app guard — and a query is refetched on focus when *any* of its
 * observers considers it stale. One observer registered without a staleTime is
 * therefore enough to make every tab focus re-fetch `/me`, whatever the other
 * four asked for. A key-level default applies to all of them.
 *
 * `['me', 'mfa']` shares the prefix and inherits this, which is what its own
 * call site already asks for; its mutations invalidate explicitly, and
 * invalidation ignores staleTime.
 */
queryClient.setQueryDefaults(queryKeys.me, { staleTime: ME_STALE_TIME });
