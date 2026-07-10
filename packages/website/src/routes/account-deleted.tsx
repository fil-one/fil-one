import { createRoute } from '@tanstack/react-router';
import { Route as rootRoute } from './__root.js';
import { AccountDeletedPage } from '../pages/AccountDeletedPage.js';

// Deliberately unauthenticated: the deletion response cleared the session
// cookies before the browser lands here (FIL-112).
export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account-deleted',
  component: AccountDeletedPage,
});
