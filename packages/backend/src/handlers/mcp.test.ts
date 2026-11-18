import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Region } from '@filone/shared';

vi.mock('sst', () => ({ Resource: {} }));

const listOrgBuckets = vi.fn();
vi.mock('../lib/list-org-buckets.ts', () => ({
  listOrgBuckets: (...args: unknown[]) => listOrgBuckets(...args),
}));

import { baseHandler } from './mcp.ts';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../lib/mcp/mcp-server.ts';
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

async function send(body: unknown) {
  const result = await baseHandler(
    buildEvent({ userInfo: USER_INFO, method: 'POST', body: JSON.stringify(body) }),
  );
  return { statusCode: result.statusCode, body: result.body ? JSON.parse(result.body) : undefined };
}

function callTool(name: string, args?: unknown) {
  return send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
}

describe('mcp baseHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listOrgBuckets.mockResolvedValue({ buckets: [], unavailableRegions: [], allFailed: false });
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

  it('returns the caller’s buckets from list_buckets, narrowed to the region asked for', async () => {
    listOrgBuckets.mockResolvedValue({
      buckets: [anyBucket],
      unavailableRegions: [],
      allFailed: false,
    });

    const response = await callTool('list_buckets', { region: S3Region.EuWest1 });

    expect(listOrgBuckets).toHaveBeenCalledWith(
      expect.objectContaining(USER_INFO),
      expect.objectContaining({ region: S3Region.EuWest1 }),
    );
    expect(response.body).toStrictEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ buckets: [anyBucket] }) }],
        structuredContent: { buckets: [anyBucket] },
      },
    });
  });

  it('names the unavailable regions alongside the buckets that did answer', async () => {
    listOrgBuckets.mockResolvedValue({
      buckets: [anyBucket],
      unavailableRegions: [S3Region.UsEast1],
      allFailed: false,
    });

    const response = await callTool('list_buckets');

    expect(response.body.result.structuredContent).toStrictEqual({
      buckets: [anyBucket],
      unavailableRegions: [S3Region.UsEast1],
    });
  });

  it('returns a tool error naming the regions when every network fails', async () => {
    listOrgBuckets.mockResolvedValue({
      buckets: [],
      unavailableRegions: [S3Region.EuWest1],
      allFailed: true,
    });

    const response = await callTool('list_buckets');

    expect(response.body.result).toStrictEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            message: 'Cannot list buckets in the eu-west-1 region. Please try again later.',
          }),
        },
      ],
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
