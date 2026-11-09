import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { BucketIntelligencePage } from '../../pages/BucketIntelligencePage';

export const Route = createRoute({
  path: '/bucket-intelligence',
  getParentRoute: () => appRoute,
  component: BucketIntelligencePage,
});
