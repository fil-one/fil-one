import { useQuery } from '@tanstack/react-query';
import type { OrgRole, Permission } from '@filone/shared';

import { getMe } from './api.js';
import { ME_STALE_TIME, queryKeys } from './query-client.js';

/**
 * What the caller's role in the active org permits, as the server computed it.
 *
 * The same shape as `useRagAccess`: `/me` ships a decision the server already
 * made, and the console reads it rather than deriving one. Fail-closed while
 * the query is loading or after it failed — a permission list that briefly
 * defaults to "everything" flashes a Delete button at a ReadOnly member, and a
 * list that defaults to "nothing" only hides a control for a moment.
 *
 * The server is the enforcement point. Everything below hides what the API
 * would refuse; nothing here decides anything.
 */
export function usePermissions(): {
  /** Whether the caller holds a permission. False until `/me` says otherwise. */
  has: (permission: Permission) => boolean;
  /**
   * The caller's own user id, for the rules that are about ownership rather
   * than authority — revoking a key you created, say. Undefined until `/me`
   * answers, which fails those rules closed like everything else here.
   *
   * It rides along with the permissions instead of getting its own `useQuery`
   * so that `/me` keeps exactly one set of query options: an observer
   * registered without this hook's staleTime would make every window focus
   * refetch `/me` for everybody.
   */
  userId: string | undefined;
  /**
   * The caller's role in the active org, for the two rules the permission list
   * cannot express on its own: which roles they may hand out, and which members
   * they may touch. Both are the shared target ceiling, which is written over
   * roles — so the console asks it the same question the server does instead of
   * re-deriving the answer from permissions and drifting.
   *
   * Undefined until `/me` answers, and undefined for a caller with no membership
   * row, which fails those rules closed like everything else here.
   */
  role: OrgRole | undefined;
  /** True while the answer is not yet known — render nothing rather than guess. */
  isPending: boolean;
  /** True when `/me` could not be read, which also grants nothing. */
  isError: boolean;
  /** True once the caller is known to hold no permissions at all. */
  isNotAMember: boolean;
} {
  const {
    data: me,
    isPending,
    isError,
  } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });

  const permissions = me?.permissions;

  return {
    has: (permission: Permission) => permissions?.includes(permission) ?? false,
    userId: me?.userId,
    role: me?.role,
    isPending,
    isError,
    // `role` is absent exactly when the caller has no membership row, which the
    // backend reports rather than defaulting. An empty permission list on its
    // own is not the same thing: a role could in principle hold none.
    isNotAMember: !isPending && !isError && me?.role === undefined,
  };
}

/**
 * Whether the caller holds one permission — the common case, and the reason
 * most call sites need no destructuring.
 */
export function useHasPermission(permission: Permission): boolean {
  return usePermissions().has(permission);
}
