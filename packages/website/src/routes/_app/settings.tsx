import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { SettingsPage } from '../../pages/SettingsPage';

export const Route = createRoute({
  path: '/settings',
  getParentRoute: () => appRoute,
  component: SettingsPage,
});
