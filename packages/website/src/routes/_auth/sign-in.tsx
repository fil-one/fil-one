import { createRoute } from '@tanstack/react-router';
import { Route as authRoute } from '../_auth';
import { SignInPage } from '../../pages/SignInPage';

export const Route = createRoute({
  path: '/sign-in',
  getParentRoute: () => authRoute,
  component: SignInPage,
});
