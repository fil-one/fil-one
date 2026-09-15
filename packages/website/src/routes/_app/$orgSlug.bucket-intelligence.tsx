import { createRoute } from '@tanstack/react-router';

import { Route as orgSlugRoute } from './$orgSlug';
import { BucketIntelligencePage } from '../../pages/BucketIntelligencePage';

export const Route = createRoute({
  path: '/bucket-intelligence',
  getParentRoute: () => orgSlugRoute,
  component: BucketIntelligencePage,
});
