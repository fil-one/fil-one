import { Stage } from '@filone/shared';

import { FILONE_STAGE } from '../env';

/**
 * The MCP routes stay dark in production until launch. Keep in step with
 * MCP_ENABLED in sst.config.ts: the routes answer 404 while it is off.
 */
export const MCP_ENABLED = FILONE_STAGE !== Stage.Production;

/** The name each agent stores the server under. */
const SERVER_NAME = 'filone';

/** The console serves MCP itself, so the URL follows the stage's own origin. */
export function getMcpServerUrl(origin: string): string {
  return `${origin}/api/mcp`;
}

export type McpClient = 'claude-code' | 'claude' | 'codex' | 'vscode';

/** One step: a sentence of what to do, or a command to run. */
export interface McpStep {
  title: string;
  note?: string;
  code?: string;
}

/**
 * How each agent adds the server and signs in. None takes a key: the agent
 * finds Auth0 from the server's metadata and the user signs in there.
 */
export function getMcpClientSteps(url: string): Record<McpClient, McpStep[]> {
  return {
    'claude-code': [
      { title: 'Add the server', code: `claude mcp add --transport http ${SERVER_NAME} ${url}` },
      {
        title: 'Sign in',
        note: `In Claude Code, run /mcp, choose ${SERVER_NAME}, then Authenticate.`,
      },
    ],
    claude: [
      {
        title: 'Add a custom connector',
        note: 'In Claude, open Customize, then Connectors. Choose Add custom connector, name it Fil One and paste the server URL.',
      },
      { title: 'Sign in', note: 'Choose Connect, then sign in with your Fil One account.' },
    ],
    codex: [
      { title: 'Add the server', code: `codex mcp add ${SERVER_NAME} --url ${url}` },
      { title: 'Sign in', code: `codex mcp login ${SERVER_NAME}` },
    ],
    vscode: [
      {
        title: 'Add the server',
        code: `code --add-mcp '${JSON.stringify({ name: SERVER_NAME, type: 'http', url })}'`,
      },
      {
        title: 'Sign in',
        note: `Start ${SERVER_NAME} from the MCP servers list, then sign in when VS Code asks.`,
      },
    ],
  };
}
