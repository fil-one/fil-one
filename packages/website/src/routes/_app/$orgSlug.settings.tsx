import { createRoute } from '@tanstack/react-router';

import { Route as orgSlugRoute } from './$orgSlug';
import { SettingsPage } from '../../pages/SettingsPage';

export const Route = createRoute({
  path: '/settings',
  getParentRoute: () => orgSlugRoute,
  component: SettingsPage,
});
