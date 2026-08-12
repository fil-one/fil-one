import { createRoute } from '@tanstack/react-router';
import { Route as rootRoute } from './__root.js';
import { AccountDeletedPage } from '../pages/AccountDeletedPage.js';

// No beforeLoad session check, unlike verify-email: the browser arrives here
// precisely because the identity is gone, and requiring a session would bounce
// it straight back to /login where SSO would re-authenticate the tombstone.
export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account-deleted',
  component: AccountDeletedPage,
});
