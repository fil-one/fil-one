import { describe, it, expect } from 'vitest';

import { getMcpClientSteps, getMcpServerUrl } from './mcp-connect.js';

const URL = 'https://any-console.test/api/mcp';

describe('getMcpServerUrl', () => {
  it('serves MCP at /api/mcp on the console origin', () => {
    expect(getMcpServerUrl('https://any-console.test')).toBe(URL);
  });
});

describe('getMcpClientSteps', () => {
  it.each([
    [
      'claude-code',
      [
        {
          title: 'Add the server',
          code: `claude mcp add --transport http filone ${URL}`,
        },
        {
          title: 'Sign in',
          note: 'In Claude Code, run /mcp, choose filone, then Authenticate.',
        },
      ],
    ],
    [
      'claude',
      [
        {
          title: 'Add a custom connector',
          note: 'In Claude, open Customize, then Connectors. Choose Add custom connector, name it Fil One and paste the server URL.',
        },
        {
          title: 'Sign in',
          note: 'Choose Connect, then sign in with your Fil One account.',
        },
      ],
    ],
    [
      'codex',
      [
        { title: 'Add the server', code: `codex mcp add filone --url ${URL}` },
        { title: 'Sign in', code: 'codex mcp login filone' },
      ],
    ],
    [
      'vscode',
      [
        {
          title: 'Add the server',
          code: `code --add-mcp '{"name":"filone","type":"http","url":"${URL}"}'`,
        },
        {
          title: 'Sign in',
          note: 'Start filone from the MCP servers list, then sign in when VS Code asks.',
        },
      ],
    ],
  ] as const)('gives %s the steps to add the server and sign in', (client, steps) => {
    expect(getMcpClientSteps(URL)[client]).toStrictEqual(steps);
  });
});
