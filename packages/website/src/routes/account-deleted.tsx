import { createRoute } from '@tanstack/react-router';
import { Route as rootRoute } from './__root.js';
import { AccountDeletedPage } from '../pages/AccountDeletedPage.js';

// Deliberately unauthenticated (FIL-112): the browser can land here with the
// session cookies already cleared (the auth middleware and auth-callback clear
// them) or still live (every other ACCOUNT_DELETED emitter clears nothing —
// backend `lib/account-deleted-response.ts`), so this route must render
// without a session rather than assume one was torn down.
export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account-deleted',
  component: AccountDeletedPage,
});
