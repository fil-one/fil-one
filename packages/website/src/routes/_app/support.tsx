import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { SupportPage } from '../../components/pages/SupportPage';

export const Route = createRoute({
  path: '/support',
  getParentRoute: () => appRoute,
  component: SupportPage,
});
