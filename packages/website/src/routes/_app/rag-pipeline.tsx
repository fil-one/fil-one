import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { RagPipelinePage } from '../../pages/RagPipelinePage';

export const Route = createRoute({
  path: '/rag-pipeline',
  getParentRoute: () => appRoute,
  component: RagPipelinePage,
});
