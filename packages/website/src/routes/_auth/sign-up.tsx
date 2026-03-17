import { createRoute } from '@tanstack/react-router';
import { Route as authRoute } from '../_auth';
import { SignUpPage } from '../../pages/SignUpPage';

export const Route = createRoute({
  path: '/sign-up',
  getParentRoute: () => authRoute,
  component: SignUpPage,
});
