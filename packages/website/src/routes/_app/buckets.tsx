import { createRoute } from '@tanstack/react-router';
import { Route as appRoute } from '../_app';
import { BucketsPage } from '../../components/pages/BucketsPage';

export const Route = createRoute({
  path: '/buckets',
  getParentRoute: () => appRoute,
  component: BucketsPage,
});
