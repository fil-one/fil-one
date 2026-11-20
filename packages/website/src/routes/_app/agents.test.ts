import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../_app', () => ({ Route: {} }));

// The route follows the stage's MCP flag; each test sets it.
const mcpFlag = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../lib/mcp-connect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/mcp-connect.js')>()),
  get MCP_ENABLED() {
    return mcpFlag.enabled;
  },
}));

import { Route as agentsRoute } from './agents';

type BeforeLoad = () => unknown;

function thrownBy(route: typeof agentsRoute): unknown {
  try {
    // `beforeLoad` is typed to take the router's full context, which this
    // route never reads, so it is called here with none.
    (route.options.beforeLoad as unknown as BeforeLoad)();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('the /agents route', () => {
  beforeEach(() => {
    mcpFlag.enabled = true;
  });

  it('opens the page while MCP is on', () => {
    expect(thrownBy(agentsRoute)).toBeUndefined();
  });

  it('sends /agents to the dashboard while MCP is off, replacing the history entry', () => {
    mcpFlag.enabled = false;

    expect(thrownBy(agentsRoute)).toMatchObject({
      status: 307,
      options: { to: '/dashboard', replace: true },
    });
  });
});
