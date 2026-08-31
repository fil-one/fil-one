import { useQuery } from '@tanstack/react-query';

import { getMe } from './api.js';
import { ME_STALE_TIME, queryKeys } from './query-client.js';

/** What the console knows about whether this org has a members surface at all. */
export interface MembersSurface {
  /** Whether to render the nav entry and the page. */
  visible: boolean;
  /** `/me` has not answered yet. */
  isPending: boolean;
  /** `/me` failed, so the answer is unknown rather than negative. */
  isError: boolean;
}

/**
 * Whether the console offers a members surface: more than one membership, or
 * the organizations beta.
 *
 * `members.read` cannot make this decision, because all four roles hold it —
 * every account would see a roster of itself and an invite form the server
 * refuses. The two conditions here are the two ways an org can have anything to
 * show: a caller already in a second org, or one whose org has been let into
 * the beta and can therefore send the first invitation.
 *
 * A solo Owner in a beta org keeps the surface, which is the case that matters:
 * somebody has to be able to send the first invite.
 *
 * Absent while `/me` is in flight, so the entry does not appear and then
 * withdraw. A failed `/me` is reported separately rather than as a `false` — a
 * caller whose network dropped should not be told their org has no members.
 */
export function useMembersSurface(): MembersSurface {
  const {
    data: me,
    isPending,
    isError,
  } = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => getMe(),
    staleTime: ME_STALE_TIME,
  });

  return {
    visible: (me?.memberships?.length ?? 0) > 1 || (me?.orgsBeta ?? false),
    isPending,
    isError,
  };
}
