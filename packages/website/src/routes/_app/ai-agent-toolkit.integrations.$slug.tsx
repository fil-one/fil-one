import { createRoute } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { AiAgentToolkitIntegrationPage } from '../../pages/AiAgentToolkitIntegrationPage';

function AiAgentToolkitIntegrationRoute() {
  const { slug } = Route.useParams();
  return <AiAgentToolkitIntegrationPage slug={slug} />;
}

export const Route = createRoute({
  path: '/ai-agent-toolkit/integrations/$slug',
  getParentRoute: () => appRoute,
  component: AiAgentToolkitIntegrationRoute,
});
