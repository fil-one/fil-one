import { createRoute, redirect } from '@tanstack/react-router';

import { Route as orgSlugRoute } from './$orgSlug';

/**
 * `/{orgSlug}/organization` renamed to `/{orgSlug}/edit-organization`. Kept as
 * a redirect rather than deleted: it is in the org switcher's own history,
 * in bookmarks, and in whatever anybody has linked to it. `replace` so the
 * back button returns where the caller came from rather than bouncing
 * through here again.
 */
export const Route = createRoute({
  path: '/organization',
  getParentRoute: () => orgSlugRoute,
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/$orgSlug/edit-organization', params, replace: true });
  },
});
