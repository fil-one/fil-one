import { createRoute } from '@tanstack/react-router';

import { Route as orgSlugRoute } from './$orgSlug';
import { AiAgentToolkitPage } from '../../pages/AiAgentToolkitPage';

export const Route = createRoute({
  path: '/ai-agent-toolkit',
  getParentRoute: () => orgSlugRoute,
  component: AiAgentToolkitPage,
});
