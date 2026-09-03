import { createRoute } from '@tanstack/react-router';
import { Route as orgSlugRoute } from './$orgSlug';
import { BucketsPage } from '../../pages/BucketsPage';

export const Route = createRoute({
  path: '/buckets',
  getParentRoute: () => orgSlugRoute,
  component: BucketsPage,
});
