import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createFthManagementClient,
  FthApiError,
  FthConflictError,
  FthNotFoundError,
  FthUnauthorizedError,
  type FthManagementClient,
} from './fth-management-client.js';

function mockFetch(status: number, body: unknown = {}): typeof fetch {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function buildClient(opts?: { fetch?: typeof fetch; token?: string }): FthManagementClient {
  return createFthManagementClient({
    baseUrl: 'https://api.fortilyx.com',
    token: opts?.token ?? 'kid.secret',
    fetch: opts?.fetch,
  });
}

function lastRequest(fetchMock: typeof fetch): Request {
  const calls = vi.mocked(fetchMock).mock.calls;
  return calls[calls.length - 1][0] as Request;
}

describe('FthClient request building', () => {
  it('sends the bearer token in Authorization header on every request', async () => {
    const fetchMock = mockFetch(200, { id: '1', externalId: 'org-1' });
    const client = buildClient({ fetch: fetchMock, token: 'my-key-id.my-secret' });

    await client.getClient('org-1');

    const req = lastRequest(fetchMock);
    expect(req.headers.get('Authorization')).toBe('Bearer my-key-id.my-secret');
  });

  it('forwards Idempotency-Key header when supplied', async () => {
    const fetchMock = mockFetch(201, { id: '1' });
    const client = buildClient({ fetch: fetchMock });

    await client.createClient({
      externalId: 'org-1',
      displayName: 'Org One',
      idempotencyKey: 'idemp-xyz',
    });

    const req = lastRequest(fetchMock);
    expect(req.headers.get('Idempotency-Key')).toBe('idemp-xyz');
  });

  it('sends Content-Type application/json on requests with a body', async () => {
    const fetchMock = mockFetch(201, { id: '1' });
    const client = buildClient({ fetch: fetchMock });

    await client.createClient({
      externalId: 'org-1',
      displayName: 'Org One',
      idempotencyKey: 'k',
    });

    const req = lastRequest(fetchMock);
    expect(req.headers.get('Content-Type')).toBe('application/json');
  });

  it('omits Content-Type on requests without a body', async () => {
    const fetchMock = mockFetch(200, { id: '1' });
    const client = buildClient({ fetch: fetchMock });

    await client.getClient('org-1');

    const req = lastRequest(fetchMock);
    expect(req.headers.get('Content-Type')).toBeNull();
  });

  it('serialises the request body as JSON', async () => {
    const fetchMock = mockFetch(201, { id: '1' });
    const client = buildClient({ fetch: fetchMock });

    await client.createClient({
      externalId: 'org-1',
      displayName: 'Org One',
      idempotencyKey: 'k',
    });

    const req = lastRequest(fetchMock);
    expect(await req.json()).toEqual({ externalId: 'org-1', displayName: 'Org One' });
  });

  it('builds the URL from baseUrl + management path', async () => {
    const fetchMock = mockFetch(200, { id: '1' });
    const client = buildClient({ fetch: fetchMock });

    await client.getClient('client-code');

    const req = lastRequest(fetchMock);
    expect(req.url).toBe('https://api.fortilyx.com/management/v1/clients/client-code');
  });
});

describe('FthClient error handling', () => {
  it('throws FthUnauthorizedError on 401', async () => {
    const client = buildClient({ fetch: mockFetch(401, { message: 'missing bearer' }) });
    await expect(client.getClient('x')).rejects.toBeInstanceOf(FthUnauthorizedError);
  });

  it('throws FthNotFoundError on 404', async () => {
    const client = buildClient({ fetch: mockFetch(404, { message: 'not found' }) });
    await expect(client.getClient('x')).rejects.toBeInstanceOf(FthNotFoundError);
  });

  it('throws FthConflictError on 409', async () => {
    const client = buildClient({ fetch: mockFetch(409, { message: 'conflict' }) });
    await expect(
      client.createClient({ externalId: 'a', displayName: 'b', idempotencyKey: 'c' }),
    ).rejects.toBeInstanceOf(FthConflictError);
  });

  it('throws plain FthApiError on other non-2xx status', async () => {
    const fetchMock = mockFetch(500, { message: 'internal error' });
    const client = buildClient({ fetch: fetchMock });

    await expect(client.getClient('x')).rejects.toMatchObject({
      name: 'FthApiError',
      status: 500,
      message: expect.stringContaining('internal error'),
    });
  });

  it('exposes the parsed error envelope on the thrown error', async () => {
    const client = buildClient({ fetch: mockFetch(400, { message: 'bad request' }) });

    try {
      await client.getClient('x');
      expect.fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FthApiError);
      expect((err as FthApiError).status).toBe(400);
      expect((err as FthApiError).responseBody).toEqual({ message: 'bad request' });
    }
  });
});

describe('FthClient response handling', () => {
  it('returns undefined for 204 No Content', async () => {
    const fetchMock = mockFetch(204);
    const client = buildClient({ fetch: fetchMock });

    const result = await client.deleteAccessKey('client-1', 'AKIA123', { idempotencyKey: 'k' });
    expect(result).toBeUndefined();
  });

  it('returns parsed JSON for 2xx responses', async () => {
    const fetchMock = mockFetch(201, { id: '42', externalId: 'org-1', displayName: 'Org One' });
    const client = buildClient({ fetch: fetchMock });

    const result = await client.createClient({
      externalId: 'org-1',
      displayName: 'Org One',
      idempotencyKey: 'k',
    });

    expect(result).toMatchObject({ id: '42', externalId: 'org-1', displayName: 'Org One' });
  });
});

describe('FthClient interceptors', () => {
  it('runs request interceptors before fetch', async () => {
    const fetchMock = mockFetch(200, { id: '1' });
    const client = buildClient({ fetch: fetchMock });

    const seen: string[] = [];
    client.interceptors.request.use((req) => {
      seen.push('req');
      return req;
    });

    await client.getClient('x');
    expect(seen).toEqual(['req']);
  });

  it('runs response interceptors with the original request and url', async () => {
    const fetchMock = mockFetch(200, { id: '1' });
    const client = buildClient({ fetch: fetchMock });

    const seen: Array<{ status: number; method: string; url: string }> = [];
    client.interceptors.response.use((res, req, opts) => {
      seen.push({ status: res.status, method: req.method, url: opts.url ?? '' });
      return res;
    });

    await client.getClient('x');
    expect(seen).toEqual([
      {
        status: 200,
        method: 'GET',
        url: '/management/v1/clients/{clientRef}',
      },
    ]);
  });

  it('runs error interceptors with undefined response on network failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const client = buildClient({ fetch: fetchMock });

    const seen: Array<{ hasResponse: boolean }> = [];
    client.interceptors.error.use((_err, response, _req, _opts) => {
      seen.push({ hasResponse: response !== undefined });
    });

    await expect(client.getClient('x')).rejects.toBeInstanceOf(TypeError);
    expect(seen).toEqual([{ hasResponse: false }]);
  });

  it('replaces the thrown HTTP error with the value returned from an error interceptor', async () => {
    const client = buildClient({ fetch: mockFetch(500, { message: 'boom' }) });

    const wrapped = new Error('wrapped');
    client.interceptors.error.use(() => wrapped);

    await expect(client.getClient('x')).rejects.toBe(wrapped);
  });

  it('replaces the thrown network error with the value returned from an error interceptor', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const client = buildClient({ fetch: fetchMock });

    const wrapped = new Error('wrapped network');
    client.interceptors.error.use(() => wrapped);

    await expect(client.getClient('x')).rejects.toBe(wrapped);
  });

  it('keeps the original error when an interceptor returns undefined', async () => {
    const client = buildClient({ fetch: mockFetch(500, { message: 'boom' }) });

    client.interceptors.error.use(() => undefined);

    await expect(client.getClient('x')).rejects.toMatchObject({
      name: 'FthApiError',
      status: 500,
    });
  });

  it('threads the replaced error through subsequent interceptors', async () => {
    const client = buildClient({ fetch: mockFetch(500, { message: 'boom' }) });

    const first = new Error('first');
    const second = new Error('second');
    const seen: unknown[] = [];
    client.interceptors.error.use(() => first);
    client.interceptors.error.use((err) => {
      seen.push(err);
      return second;
    });

    await expect(client.getClient('x')).rejects.toBe(second);
    expect(seen).toEqual([first]);
  });

  it('runs interceptors in registration order', async () => {
    const fetchMock = mockFetch(200, { id: '1' });
    const client = buildClient({ fetch: fetchMock });

    const seen: number[] = [];
    client.interceptors.request.use((req) => {
      seen.push(1);
      return req;
    });
    client.interceptors.request.use((req) => {
      seen.push(2);
      return req;
    });

    await client.getClient('x');
    expect(seen).toEqual([1, 2]);
  });
});

describe('FthClient endpoint coverage', () => {
  let fetchMock: typeof fetch;
  let client: FthManagementClient;

  beforeEach(() => {
    fetchMock = mockFetch(200, {});
    client = buildClient({ fetch: fetchMock });
  });

  it('createStorageUser POSTs to the nested path with Idempotency-Key', async () => {
    fetchMock = mockFetch(201, { id: '7' });
    client = buildClient({ fetch: fetchMock });

    await client.createStorageUser('client-1', {
      email: 'user@example.com',
      displayName: 'User',
      userCode: 'user-1',
      role: 'storage_user',
      issueS3Credentials: false,
      idempotencyKey: 'idem-1',
    });

    const req = lastRequest(fetchMock);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.fortilyx.com/management/v1/clients/client-1/storage-users');
    expect(req.headers.get('Idempotency-Key')).toBe('idem-1');
  });

  it('listStorageUsers GETs the collection', async () => {
    fetchMock = mockFetch(200, [{ id: '1', userCode: 'u' }]);
    client = buildClient({ fetch: fetchMock });

    const result = await client.listStorageUsers('client-1');
    const req = lastRequest(fetchMock);
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.fortilyx.com/management/v1/clients/client-1/storage-users');
    expect(result).toEqual([{ id: '1', userCode: 'u' }]);
  });

  it('createAccessKey POSTs to the storage-user nested path', async () => {
    fetchMock = mockFetch(201, { accessKeyId: 'AK', secretAccessKey: 'SK' });
    client = buildClient({ fetch: fetchMock });

    await client.createAccessKey('client-1', 'user-1', {
      name: 'k',
      permissions: ['s3:GetObject'],
      buckets: [],
      expiresAt: null,
      idempotencyKey: 'idem-key',
    });

    const req = lastRequest(fetchMock);
    expect(req.url).toBe(
      'https://api.fortilyx.com/management/v1/clients/client-1/storage-users/user-1/access-keys',
    );
    expect(req.method).toBe('POST');
    expect(await req.json()).toEqual({
      name: 'k',
      permissions: ['s3:GetObject'],
      buckets: [],
      expiresAt: null,
    });
  });

  it('listAccessKeys GETs the client-level collection', async () => {
    fetchMock = mockFetch(200, []);
    client = buildClient({ fetch: fetchMock });

    await client.listAccessKeys('client-1');
    const req = lastRequest(fetchMock);
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.fortilyx.com/management/v1/clients/client-1/access-keys');
  });

  it('deleteAccessKey sends DELETE', async () => {
    fetchMock = mockFetch(204);
    client = buildClient({ fetch: fetchMock });

    await client.deleteAccessKey('client-1', 'AKIA-1');

    const req = lastRequest(fetchMock);
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe(
      'https://api.fortilyx.com/management/v1/clients/client-1/access-keys/AKIA-1',
    );
  });
});
