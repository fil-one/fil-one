import { createRoute } from '@tanstack/react-router';
import { Route as appRoute } from '../_app';
import { CreateBucketPage } from '../../pages/CreateBucketPage';

export const Route = createRoute({
  path: '/buckets/create',
  getParentRoute: () => appRoute,
  component: CreateBucketPage,
});
