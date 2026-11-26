import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Region } from '@filone/shared';
import type { OrgMembership } from '../lib/org-membership.ts';

vi.mock('sst', () => ({ Resource: {} }));

const callConsoleRoute = vi.fn();
vi.mock('../lib/mcp/mcp-console-route.ts', () => ({
  callConsoleRoute: (...args: unknown[]) => callConsoleRoute(...args),
}));

import type { Context } from 'aws-lambda';
import { baseHandler, handler as mcpHandler } from './mcp.ts';
import { handler as mcpGetHandler } from './mcp-get.ts';
import { handler as mcpResourceMetadataHandler } from './mcp-resource-metadata.ts';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../lib/mcp/mcp-server.ts';
import { AccessLevel } from '../middleware/subscription-guard.ts';
import { buildEvent } from '../test/lambda-test-utilities.ts';

const USER_INFO = { userId: 'any-user', orgId: 'any-org' };

const anyBucket = {
  bucketName: 'any-bucket',
  region: S3Region.EuWest1,
  createdAt: '2026-01-01T00:00:00.000Z',
  isPublic: false,
  versioning: false,
  encrypted: true,
};

async function send(body: unknown, membership?: OrgMembership) {
  const result = await baseHandler(
    buildEvent({
      userInfo: { ...USER_INFO, membership },
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  return { statusCode: result.statusCode, body: result.body ? JSON.parse(result.body) : undefined };
}

function callTool(name: string, args?: unknown) {
  return send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
}

describe('mcp baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callConsoleRoute.mockResolvedValue({ statusCode: 200, body: { buckets: [] } });
  });

  it.each([
    ['echoes a protocol version it supports', '2025-06-18', '2025-06-18'],
    [
      'offers its newest version for one it does not support',
      '1999-01-01',
      SUPPORTED_PROTOCOL_VERSIONS[0],
    ],
  ])('%s on initialize', async (_case, requested, expected) => {
    const response = await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: 'any-client' } },
    });

    expect(response).toStrictEqual({
      statusCode: 200,
      body: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: expected,
          capabilities: { tools: {} },
          serverInfo: { name: 'fil-one', version: '0.1.0' },
        },
      },
    });
  });

  it('answers a notification with 202 and no body', async () => {
    const response = await send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    expect(response).toStrictEqual({ statusCode: 202, body: undefined });
  });

  it('lists list_buckets as its only tool, marked read-only', async () => {
    const response = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(response.body.result.tools).toMatchObject([
      { name: 'list_buckets', annotations: { readOnlyHint: true } },
    ]);
  });

  it('lists buckets by running GET /api/buckets as the caller, narrowed to the region asked for', async () => {
    callConsoleRoute.mockResolvedValue({
      statusCode: 200,
      body: { buckets: [anyBucket], unavailableRegions: [S3Region.UsEast1] },
    });

    const response = await callTool('list_buckets', { region: S3Region.EuWest1 });

    expect(callConsoleRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        requestContext: expect.objectContaining({ userInfo: expect.objectContaining(USER_INFO) }),
      }),
      {
        handler: 'list-buckets',
        baseHandler: expect.any(Function),
        accessLevel: AccessLevel.Read,
        queryStringParameters: { region: S3Region.EuWest1 },
      },
    );
    const answer = { buckets: [anyBucket], unavailableRegions: [S3Region.UsEast1] };
    expect(response.body).toStrictEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        structuredContent: answer,
      },
    });
  });

  it.each([
    // The schema asks for a string, not a list.
    ['a region that is not a string', { region: [S3Region.EuWest1] }, 'region must be one of'],
    // No such region.
    ['an unknown region', { region: 'any-unknown-region' }, 'region must be one of'],
    // The schema allows no other properties.
    ['an argument the tool does not take', { bucket: 'any-bucket' }, 'unknown argument: bucket'],
    // Arguments are an object.
    ['arguments that are not an object', S3Region.EuWest1, 'arguments must be an object'],
  ])('returns a tool error and lists nothing for %s', async (_case, args, problem) => {
    const response = await callTool('list_buckets', args);

    expect(callConsoleRoute).not.toHaveBeenCalled();
    expect(response.body.result).toStrictEqual({
      content: [{ type: 'text', text: expect.stringContaining(`Invalid arguments: ${problem}`) }],
      isError: true,
    });
  });

  it.each([
    [
      'a role without buckets.read',
      403,
      'Your role in this organization does not permit this action.',
    ],
    [
      'every network failing',
      503,
      'Cannot list buckets in the eu-west-1 region. Please try again later.',
    ],
  ])('returns the route’s refusal as a tool error for %s', async (_case, statusCode, message) => {
    callConsoleRoute.mockResolvedValue({ statusCode, body: { message } });

    const response = await callTool('list_buckets');

    expect(response.body.result).toStrictEqual({
      content: [{ type: 'text', text: JSON.stringify({ message }) }],
      isError: true,
    });
  });

  it.each([
    [
      'Invalid params for an unknown tool',
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delete_everything' } },
      {
        jsonrpc: '2.0',
        id: 3,
        error: { code: -32602, message: 'Unknown tool: delete_everything' },
      },
    ],
    [
      'Method not found for an unknown method',
      { jsonrpc: '2.0', id: 4, method: 'resources/list' },
      {
        jsonrpc: '2.0',
        id: 4,
        error: { code: -32601, message: 'Method not found: resources/list' },
      },
    ],
    [
      // Batches were removed from the protocol in 2025-06-18.
      'Invalid Request for a batch',
      [{ jsonrpc: '2.0', id: 5, method: 'ping' }],
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    ],
  ])('returns %s', async (_case, request, expected) => {
    const response = await send(request);

    expect(response).toStrictEqual({ statusCode: 200, body: expected });
  });

  it('refuses a request carrying an MCP-Protocol-Version it does not support with 400', async () => {
    const event = buildEvent({
      userInfo: USER_INFO,
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'list_buckets' },
      }),
    });
    event.headers['mcp-protocol-version'] = '1999-01-01';

    const result = await baseHandler(event);

    expect(callConsoleRoute).not.toHaveBeenCalled();
    expect({ statusCode: result.statusCode, body: JSON.parse(result.body!) }).toStrictEqual({
      statusCode: 400,
      body: {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Unsupported MCP-Protocol-Version: 1999-01-01' },
      },
    });
  });

  it('serves a request carrying an MCP-Protocol-Version it supports', async () => {
    const event = buildEvent({
      userInfo: USER_INFO,
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
    });
    event.headers['mcp-protocol-version'] = SUPPORTED_PROTOCOL_VERSIONS[1];

    const result = await baseHandler(event);

    expect({ statusCode: result.statusCode, body: JSON.parse(result.body!) }).toStrictEqual({
      statusCode: 200,
      body: { jsonrpc: '2.0', id: 9, result: {} },
    });
  });

  it('returns a Parse error for a body that is not JSON', async () => {
    const result = await baseHandler(
      buildEvent({ userInfo: USER_INFO, method: 'POST', body: '{not json' }),
    );

    expect(JSON.parse(result.body!)).toStrictEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  });
});

describe('the MCP routes while MCP is off', () => {
  beforeEach(() => {
    delete process.env.MCP_ENABLED;
  });

  it.each([
    ['POST /api/mcp', mcpHandler],
    ['GET /api/mcp', mcpGetHandler],
    ['the resource metadata', mcpResourceMetadataHandler],
  ])('answers 404 for %s, before any sign-in', async (_route, routeHandler) => {
    const result = await routeHandler(
      buildEvent({ userInfo: USER_INFO, method: 'POST' }),
      {} as Context,
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });
});
