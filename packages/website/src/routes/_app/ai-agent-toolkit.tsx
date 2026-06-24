import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { AiAgentToolkitPage } from '../../pages/AiAgentToolkitPage';

export const Route = createRoute({
  path: '/ai-agent-toolkit',
  getParentRoute: () => appRoute,
  component: AiAgentToolkitPage,
});
