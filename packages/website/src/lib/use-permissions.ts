import { useQuery } from '@tanstack/react-query';
import type { Permission } from '@filone/shared';

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
