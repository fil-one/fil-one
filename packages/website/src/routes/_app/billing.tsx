import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { BillingPage } from '../../pages/BillingPage';

export const Route = createRoute({
  path: '/billing',
  getParentRoute: () => appRoute,
  component: BillingPage,
});
