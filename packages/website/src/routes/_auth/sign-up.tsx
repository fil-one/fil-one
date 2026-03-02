import { createRoute } from '@tanstack/react-router';
import { Route as authRoute } from '../_auth';
import { SignUpPage } from '../../components/pages/SignUpPage';

export const Route = createRoute({
  path: '/sign-up',
  getParentRoute: () => authRoute,
  component: SignUpPage,
});
