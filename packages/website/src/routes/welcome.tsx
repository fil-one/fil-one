import { createRoute, redirect } from '@tanstack/react-router';
import { Route as rootRoute } from './__root.js';

/**
 * `/welcome` renamed to `/create-organization`, so the URL says what the step
 * actually is (naming the org an account gets on signup) rather than a name
 * generic enough to fit unrelated later screens too. Kept as a redirect
 * rather than deleted, in case anything has this bookmarked. `replace` so the
 * back button returns where the caller came from rather than bouncing
 * through here again.
 */
export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/welcome',
  beforeLoad: () => {
    throw redirect({ to: '/create-organization', replace: true });
  },
});
