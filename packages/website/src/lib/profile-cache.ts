import { useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@filone/shared';

import { queryKeys } from './query-client.js';

/**
 * Patches `/me`'s cached shape after a `PATCH /api/me/profile` save, so the
 * sidebar, the org switcher, and this page itself all see the new value
 * without a round-trip. Shared by every field the profile form can save -
 * name, email, and the avatar - rather than one patcher per field, since all
 * three land in the same response and the same two query keys.
 */
export function applyProfileUpdate(result: {
  name?: string;
  email?: string;
  picture?: string;
}): (old: MeResponse | undefined) => MeResponse | undefined {
  return (old) => {
    if (!old) return old;
    return {
      ...old,
      ...(result.name !== undefined ? { name: result.name } : {}),
      // An email change always resets verification — reflect it immediately so
      // the verify-email gate in _app.tsx re-triggers without a /me round-trip.
      ...(result.email !== undefined ? { email: result.email, emailVerified: false } : {}),
      ...(result.picture !== undefined ? { picture: result.picture } : {}),
    };
  };
}

export function usePatchProfileCache() {
  const queryClient = useQueryClient();
  return (saved: { name?: string; email?: string; picture?: string }) => {
    const update = applyProfileUpdate(saved);
    queryClient.setQueryData<MeResponse>(queryKeys.me, update);
    queryClient.setQueryData<MeResponse>(queryKeys.meWithMfa, update);
  };
}
