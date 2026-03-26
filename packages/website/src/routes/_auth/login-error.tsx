import { createRoute } from '@tanstack/react-router';
import { Route as authRoute } from '../_auth';
import { LoginErrorPage } from '../../pages/LoginErrorPage';

export const Route = createRoute({
  path: '/login-error',
  getParentRoute: () => authRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === 'string' ? search.error : 'An unexpected error occurred',
  }),
  component: LoginErrorRoute,
});

function LoginErrorRoute() {
  const { error } = Route.useSearch();
  return <LoginErrorPage error={error} />;
}
