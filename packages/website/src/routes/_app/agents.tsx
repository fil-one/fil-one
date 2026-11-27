import { createRoute, redirect } from '@tanstack/react-router';

import { Route as appRoute } from '../_app';
import { AgentsPage } from '../../pages/AgentsPage';
import { MCP_ENABLED } from '../../lib/mcp-connect.js';

/** Sends the page to the dashboard while MCP is off, as its sidebar entry is hidden then. */
export const Route = createRoute({
  path: '/agents',
  getParentRoute: () => appRoute,
  beforeLoad: () => {
    if (!MCP_ENABLED) throw redirect({ to: '/dashboard', replace: true });
  },
  component: AgentsPage,
});
