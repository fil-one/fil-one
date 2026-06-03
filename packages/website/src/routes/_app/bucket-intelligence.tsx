import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { RagPipelinePage } from '../../pages/RagPipelinePage';

export const Route = createRoute({
  path: '/bucket-intelligence',
  getParentRoute: () => appRoute,
  component: RagPipelinePage,
});
