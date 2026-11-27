import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrgRole, S3Region } from '@filone/shared';
import type { OrgMembership } from '../lib/org-membership.ts';

vi.mock('sst', () => ({ Resource: {} }));

const callConsoleRoute = vi.fn();
vi.mock('../lib/mcp/mcp-console-route.ts', () => ({
  callConsoleRoute: (...args: unknown[]) => callConsoleRoute(...args),
}));

const listBucketObjects = vi.fn();
vi.mock('../lib/mcp/mcp-list-objects.ts', () => ({
  listBucketObjects: (...args: unknown[]) => listBucketObjects(...args),
}));

import type { Context } from 'aws-lambda';
import { MAX_BATCH_SIZE, baseHandler, handler as mcpHandler } from './mcp.ts';
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

  it('lists its tools, marking the ones that only read', async () => {
    const response = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(response.body.result.tools).toMatchObject([
      { name: 'list_buckets', annotations: { readOnlyHint: true } },
      { name: 'get_account', annotations: { readOnlyHint: true } },
      { name: 'list_access_keys', annotations: { readOnlyHint: true } },
      { name: 'get_bucket', annotations: { readOnlyHint: true } },
      { name: 'create_bucket', annotations: { readOnlyHint: false, destructiveHint: false } },
      { name: 'delete_bucket', annotations: { destructiveHint: true, idempotentHint: true } },
      { name: 'list_objects', annotations: { readOnlyHint: true } },
      { name: 'get_download_url', annotations: { readOnlyHint: true } },
      { name: 'get_upload_url', annotations: { readOnlyHint: false, destructiveHint: true } },
      { name: 'delete_object', annotations: { destructiveHint: true, idempotentHint: true } },
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

  function batchEvent(version: string | undefined) {
    const event = buildEvent({
      userInfo: USER_INFO,
      method: 'POST',
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ]),
    });
    if (version) event.headers['mcp-protocol-version'] = version;
    return event;
  }

  it.each([
    ['carrying MCP-Protocol-Version 2025-03-26', '2025-03-26'],
    ['carrying no MCP-Protocol-Version, which means 2025-03-26', undefined],
  ])('answers each request in a batch %s', async (_case, version) => {
    const result = await baseHandler(batchEvent(version));

    expect({ statusCode: result.statusCode, body: JSON.parse(result.body!) }).toStrictEqual({
      statusCode: 200,
      body: [
        { jsonrpc: '2.0', id: 1, result: {} },
        { jsonrpc: '2.0', id: 2, result: {} },
      ],
    });
  });

  it('answers a batch of only notifications with 202 and no body', async () => {
    const event = buildEvent({
      userInfo: USER_INFO,
      method: 'POST',
      body: JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }]),
    });

    const result = await baseHandler(event);

    expect({ statusCode: result.statusCode, body: result.body }).toStrictEqual({
      statusCode: 202,
      body: '',
    });
  });

  it('refuses with 400 a batch over the size limit, without running any of it', async () => {
    const calls = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'tools/call',
      params: { name: 'list_buckets' },
    }));

    const response = await send(calls);

    expect(response).toStrictEqual({
      statusCode: 400,
      body: {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: `A batch holds at most ${MAX_BATCH_SIZE} messages` },
      },
    });
    expect(callConsoleRoute).not.toHaveBeenCalled();
  });

  it('runs the calls in a batch one at a time', async () => {
    let running = 0;
    let mostRunning = 0;
    callConsoleRoute.mockImplementation(async () => {
      mostRunning = Math.max(mostRunning, ++running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return { statusCode: 200, body: { buckets: [] } };
    });
    const calls = [1, 2, 3].map((id) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'list_buckets' },
    }));

    const response = await send(calls);

    expect({ mostRunning, ids: response.body.map((r: { id: number }) => r.id) }).toStrictEqual({
      mostRunning: 1,
      ids: [1, 2, 3],
    });
  });

  it('refuses a batch under a protocol version that dropped batches', async () => {
    const result = await baseHandler(batchEvent('2025-06-18'));

    expect(JSON.parse(result.body!)).toStrictEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    });
  });

  describe('the Origin of a browser request', () => {
    beforeEach(() => {
      process.env.ALLOWED_REDIRECT_ORIGINS = 'https://console.any.invalid';
    });
    afterEach(() => {
      delete process.env.ALLOWED_REDIRECT_ORIGINS;
    });

    function pingFrom(origin: string) {
      const event = buildEvent({
        userInfo: USER_INFO,
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
      });
      event.headers.origin = origin;
      return baseHandler(event);
    }

    it('refuses with 403 an Origin that is not the console’s', async () => {
      const result = await pingFrom('https://other.any.invalid');

      expect({ statusCode: result.statusCode, body: JSON.parse(result.body!) }).toStrictEqual({
        statusCode: 403,
        body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Origin not allowed' } },
      });
    });

    it('serves a request from the console’s Origin', async () => {
      const result = await pingFrom('https://console.any.invalid');

      expect({ statusCode: result.statusCode, body: JSON.parse(result.body!) }).toStrictEqual({
        statusCode: 200,
        body: { jsonrpc: '2.0', id: 3, result: {} },
      });
    });
  });
});

describe('MCP tools that run a console route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the caller’s identity, org and role from get_account, as GET /api/me reads them', async () => {
    callConsoleRoute.mockResolvedValue({
      statusCode: 200,
      body: {
        userId: 'any-user',
        email: 'any@example.com',
        name: 'Any Name',
        emailVerified: true,
        orgId: 'any-org',
        orgName: 'Any Org',
        role: OrgRole.Member,
        permissions: ['buckets.read'],
        // Fields the agent has no use for stay out of the result.
        mfaEnrollments: [],
        ragAccess: false,
      },
    });

    const response = await callTool('get_account', {});

    expect(callConsoleRoute).toHaveBeenCalledWith(
      expect.objectContaining({ requestContext: expect.anything() }),
      expect.objectContaining({ handler: 'get-me', accessLevel: AccessLevel.Read }),
    );
    // No name: an MCP access token carries none, so GET /api/me has none to give.
    expect(response.body.result.structuredContent).toStrictEqual({
      userId: 'any-user',
      email: 'any@example.com',
      emailVerified: true,
      orgId: 'any-org',
      orgName: 'Any Org',
      role: OrgRole.Member,
      permissions: ['buckets.read'],
    });
  });

  it('lists access keys through GET /api/access-keys, narrowed to the region and bucket asked for', async () => {
    callConsoleRoute.mockResolvedValue({ statusCode: 200, body: { keys: [{ id: 'any-key' }] } });

    const response = await callTool('list_access_keys', {
      region: S3Region.EuWest1,
      bucket: 'any-bucket',
    });

    expect(callConsoleRoute).toHaveBeenCalledWith(expect.anything(), {
      handler: 'list-access-keys',
      baseHandler: expect.any(Function),
      accessLevel: AccessLevel.Read,
      queryStringParameters: { region: S3Region.EuWest1, bucket: 'any-bucket' },
    });
    expect(response.body.result.structuredContent).toStrictEqual({ keys: [{ id: 'any-key' }] });
  });

  it('reads a bucket through GET /api/buckets/{name} in the region given', async () => {
    callConsoleRoute.mockResolvedValue({
      statusCode: 200,
      body: { bucket: { name: 'any-bucket' } },
    });

    const response = await callTool('get_bucket', {
      bucketName: 'any-bucket',
      region: S3Region.UsEast1,
    });

    expect(callConsoleRoute).toHaveBeenCalledWith(expect.anything(), {
      handler: 'get-bucket',
      baseHandler: expect.any(Function),
      accessLevel: AccessLevel.Read,
      pathParameters: { name: 'any-bucket' },
      queryStringParameters: { region: S3Region.UsEast1 },
    });
    expect(response.body.result.structuredContent).toStrictEqual({
      bucket: { name: 'any-bucket' },
    });
  });

  it('creates a bucket through POST /api/buckets, building its retention from the flat arguments', async () => {
    callConsoleRoute.mockResolvedValue({
      statusCode: 201,
      body: { bucket: { name: 'any-bucket' } },
    });

    const response = await callTool('create_bucket', {
      bucketName: 'any-bucket',
      region: S3Region.UsEast1,
      versioning: true,
      lock: true,
      retentionMode: 'governance',
      retentionDuration: 30,
      retentionDurationType: 'd',
    });

    expect(callConsoleRoute).toHaveBeenCalledWith(expect.anything(), {
      handler: 'create-bucket',
      baseHandler: expect.any(Function),
      accessLevel: AccessLevel.Write,
      body: {
        bucketName: 'any-bucket',
        region: S3Region.UsEast1,
        versioning: true,
        lock: true,
        retention: { enabled: true, mode: 'governance', duration: 30, durationType: 'd' },
      },
    });
    expect(response.body.result.structuredContent).toStrictEqual({
      bucket: { name: 'any-bucket' },
    });
  });

  it('creates a bucket with no retention when no retention argument is given', async () => {
    callConsoleRoute.mockResolvedValue({ statusCode: 201, body: { bucket: {} } });

    await callTool('create_bucket', { bucketName: 'any-bucket', region: S3Region.UsEast1 });

    expect(callConsoleRoute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: { bucketName: 'any-bucket', region: S3Region.UsEast1 },
      }),
    );
  });

  it('passes partial retention arguments on, for the route to refuse, rather than dropping them', async () => {
    callConsoleRoute.mockResolvedValue({ statusCode: 400, body: { message: 'any' } });

    // A duration with no mode: the console's schema needs all three.
    await callTool('create_bucket', {
      bucketName: 'any-bucket',
      region: S3Region.UsEast1,
      lock: true,
      retentionDuration: 30,
      retentionDurationType: 'd',
    });

    expect(callConsoleRoute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: {
          bucketName: 'any-bucket',
          region: S3Region.UsEast1,
          lock: true,
          retention: { enabled: true, mode: undefined, duration: 30, durationType: 'd' },
        },
      }),
    );
  });

  it('deletes a bucket through DELETE /api/buckets/{name} and names the bucket it deleted', async () => {
    callConsoleRoute.mockResolvedValue({ statusCode: 204, body: undefined });

    const response = await callTool('delete_bucket', {
      bucketName: 'any-bucket',
      region: S3Region.UsEast1,
    });

    expect(callConsoleRoute).toHaveBeenCalledWith(expect.anything(), {
      handler: 'delete-bucket',
      baseHandler: expect.any(Function),
      accessLevel: AccessLevel.Write,
      pathParameters: { name: 'any-bucket' },
      queryStringParameters: { region: S3Region.UsEast1 },
    });
    expect(response.body.result.structuredContent).toStrictEqual({ deleted: 'any-bucket' });
  });

  it('lists a bucket’s objects with the arguments as checked', async () => {
    listBucketObjects.mockResolvedValue({
      statusCode: 200,
      body: { objects: [{ key: 'any-key' }], isTruncated: false },
    });
    const args = {
      bucketName: 'any-bucket',
      region: S3Region.UsEast1,
      prefix: 'any/',
      maxKeys: 10,
      continuationToken: 'any-token',
    };

    const response = await callTool('list_objects', args);

    expect(listBucketObjects).toHaveBeenCalledWith(
      expect.objectContaining({ requestContext: expect.anything() }),
      args,
    );
    expect(response.body.result.structuredContent).toStrictEqual({
      objects: [{ key: 'any-key' }],
      isTruncated: false,
    });
  });

  const SIGNED = {
    url: 'https://s3.any-endpoint.invalid/any-bucket/any/key.txt?X-Amz-Signature=any',
    expiresAt: '2026-01-01T00:05:00.000Z',
  };

  it.each([
    [
      'get_download_url',
      { versionId: 'any-version' },
      { op: 'getObject', versionId: 'any-version' },
      { method: 'GET' },
    ],
    [
      'get_upload_url',
      { contentType: 'text/plain' },
      { op: 'putObject', contentType: 'text/plain', fileName: 'key.txt' },
      { method: 'PUT', headers: { 'Content-Type': 'text/plain' } },
    ],
    [
      'get_upload_url',
      {},
      { op: 'putObject', contentType: 'application/octet-stream', fileName: 'key.txt' },
      { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' } },
    ],
    ['delete_object', {}, { op: 'deleteObject' }, { method: 'DELETE' }],
  ])(
    'signs a URL for %s through POST /api/presign, given %o',
    async (tool, extraArgs, expectedOp, expectedResult) => {
      callConsoleRoute.mockResolvedValue({
        statusCode: 200,
        body: { items: [{ ...SIGNED, method: expectedResult.method }], endpoint: 'any' },
      });

      const response = await callTool(tool, {
        bucketName: 'any-bucket',
        region: S3Region.UsEast1,
        key: 'any/key.txt',
        ...extraArgs,
      });

      expect(callConsoleRoute).toHaveBeenCalledWith(expect.anything(), {
        handler: 'presign',
        baseHandler: expect.any(Function),
        accessLevel: AccessLevel.Read,
        queryStringParameters: { region: S3Region.UsEast1 },
        body: [{ bucket: 'any-bucket', key: 'any/key.txt', ...expectedOp }],
      });
      expect(response.body.result.structuredContent).toStrictEqual({
        ...SIGNED,
        ...expectedResult,
      });
    },
  );

  it('returns the console’s refusal as a tool error', async () => {
    callConsoleRoute.mockResolvedValue({
      statusCode: 403,
      body: { message: 'Your role in this organization does not permit this action.' },
    });

    const response = await callTool('list_access_keys', {});

    expect(response.body.result).toStrictEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            message: 'Your role in this organization does not permit this action.',
          }),
        },
      ],
      isError: true,
    });
  });

  it.each([
    // The tool takes no such argument.
    [
      'an argument the tool does not take',
      'list_access_keys',
      { keyId: 'any-key' },
      'unknown argument: keyId',
    ],
    // The schema asks for a string.
    ['an argument of the wrong type', 'list_access_keys', { bucket: 7 }, 'bucket must be a string'],
    // Arguments are an object.
    ['arguments that are not an object', 'get_account', 'any', 'arguments must be an object'],
    // A bucket tool needs the bucket's region.
    [
      'a missing required argument',
      'get_bucket',
      { bucketName: 'any-bucket' },
      'missing argument: region',
    ],
    // A duration is a whole number.
    [
      'a number that is not an integer',
      'create_bucket',
      { bucketName: 'any-bucket', region: S3Region.UsEast1, retentionDuration: 1.5 },
      'retentionDuration must be an integer',
    ],
    // S3 lists at least one key a page.
    [
      'maxKeys below 1',
      'list_objects',
      { bucketName: 'any-bucket', region: S3Region.UsEast1, maxKeys: 0 },
      'maxKeys must be from 1 to 1000',
    ],
    // S3 lists at most 1000 keys a page.
    [
      'maxKeys above 1000',
      'list_objects',
      { bucketName: 'any-bucket', region: S3Region.UsEast1, maxKeys: 1001 },
      'maxKeys must be from 1 to 1000',
    ],
  ])('returns a tool error and runs no route for %s', async (_case, tool, args, problem) => {
    const response = await callTool(tool, args);

    expect(callConsoleRoute).not.toHaveBeenCalled();
    expect(listBucketObjects).not.toHaveBeenCalled();
    expect(response.body.result).toStrictEqual({
      content: [
        { type: 'text', text: JSON.stringify({ message: `Invalid arguments: ${problem}` }) },
      ],
      isError: true,
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
