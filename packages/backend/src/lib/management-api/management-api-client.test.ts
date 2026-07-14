import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createManagementApiClient,
  ManagementApiError,
  ManagementApiConflictError,
  ManagementApiNotFoundError,
  ManagementApiUnauthorizedError,
  ManagementApiValidationError,
  type ManagementApiClient,
  type ManagementMetrics,
} from './management-api-client.js';

function mockFetch(status: number, body: unknown = {}): typeof fetch {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function buildClient(opts?: { fetch?: typeof fetch; token?: string }): ManagementApiClient {
  return createManagementApiClient({
    baseUrl: 'https://api.example.com',
    token: opts?.token ?? 'partner-key',
    fetch: opts?.fetch,
  });
}

function lastRequest(fetchMock: typeof fetch): Request {
  const calls = vi.mocked(fetchMock).mock.calls;
  return calls[calls.length - 1][0] as Request;
}

const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('ManagementApiClient request building', () => {
  it('sends the partner key as a bearer token on every request', async () => {
    const fetchMock = mockFetch(200, { tenantId: TENANT_ID });
    const client = buildClient({ fetch: fetchMock, token: 'my-partner-key' });

    await client.getTenant(TENANT_ID);

    const req = lastRequest(fetchMock);
    expect(req.headers.get('Authorization')).toBe('Bearer my-partner-key');
  });

  it('never sends an Idempotency-Key header (the contract has none)', async () => {
    // Fresh Response per call — a body can only be read once.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify({ tenantId: TENANT_ID }), { status: 201 }),
      );
    const client = buildClient({ fetch: fetchMock });

    await client.putTenant(TENANT_ID, { region: 'us-east-1' });
    await client.createAccessKey(TENANT_ID, { name: 'k', permissions: ['s3:GetObject'] });

    for (const [req] of vi.mocked(fetchMock).mock.calls) {
      expect((req as Request).headers.get('Idempotency-Key')).toBeNull();
    }
  });

  it('sends Content-Type application/json on requests with a body', async () => {
    const fetchMock = mockFetch(201, { tenantId: TENANT_ID });
    const client = buildClient({ fetch: fetchMock });

    await client.putTenant(TENANT_ID, { region: 'us-east-1' });

    const req = lastRequest(fetchMock);
    expect(req.headers.get('Content-Type')).toBe('application/json');
  });

  it('omits Content-Type on requests without a body', async () => {
    const fetchMock = mockFetch(200, { tenantId: TENANT_ID });
    const client = buildClient({ fetch: fetchMock });

    await client.getTenant(TENANT_ID);

    const req = lastRequest(fetchMock);
    expect(req.headers.get('Content-Type')).toBeNull();
  });

  it('strips trailing slashes from the baseUrl', async () => {
    const fetchMock = mockFetch(200, { tenantId: TENANT_ID });
    const client = createManagementApiClient({
      baseUrl: 'https://api.example.com/',
      token: 't',
      fetch: fetchMock,
    });

    await client.getTenant(TENANT_ID);

    const req = lastRequest(fetchMock);
    expect(req.url).toBe(`https://api.example.com/tenants/${TENANT_ID}`);
  });

  it('URL-encodes path parameters', async () => {
    const fetchMock = mockFetch(200, {});
    const client = buildClient({ fetch: fetchMock });

    await client.getBucketMetrics(TENANT_ID, 'bucket/../sneaky', {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
      window: '1h',
    });

    const req = lastRequest(fetchMock);
    expect(req.url).toContain('/buckets/bucket%2F..%2Fsneaky/metrics');
  });
});

describe('ManagementApiClient error handling', () => {
  it('throws ManagementApiUnauthorizedError on 401', async () => {
    const client = buildClient({ fetch: mockFetch(401, { message: 'missing bearer' }) });
    await expect(client.getTenant(TENANT_ID)).rejects.toBeInstanceOf(
      ManagementApiUnauthorizedError,
    );
  });

  it('throws ManagementApiNotFoundError on 404', async () => {
    const client = buildClient({ fetch: mockFetch(404, { message: 'not found' }) });
    await expect(client.getTenant(TENANT_ID)).rejects.toBeInstanceOf(ManagementApiNotFoundError);
  });

  it('throws ManagementApiConflictError on 409', async () => {
    const client = buildClient({ fetch: mockFetch(409, { message: 'duplicate name' }) });
    await expect(
      client.createAccessKey(TENANT_ID, { name: 'k', permissions: ['s3:GetObject'] }),
    ).rejects.toBeInstanceOf(ManagementApiConflictError);
  });

  it('throws ManagementApiValidationError on 400', async () => {
    const client = buildClient({ fetch: mockFetch(400, { message: 'bad window' }) });
    await expect(
      client.getTenantMetrics(TENANT_ID, { from: 'x', to: 'y', window: 'bogus' }),
    ).rejects.toBeInstanceOf(ManagementApiValidationError);
  });

  it('throws ManagementApiValidationError on 422', async () => {
    const client = buildClient({ fetch: mockFetch(422, { message: 'permissions empty' }) });
    await expect(
      client.createAccessKey(TENANT_ID, { name: 'k', permissions: [] }),
    ).rejects.toBeInstanceOf(ManagementApiValidationError);
  });

  it('throws plain ManagementApiError on other non-2xx status', async () => {
    const client = buildClient({ fetch: mockFetch(500, { message: 'internal error' }) });

    await expect(client.getTenant(TENANT_ID)).rejects.toMatchObject({
      name: 'ManagementApiError',
      status: 500,
      message: expect.stringContaining('internal error'),
    });
  });

  it('exposes the parsed error envelope (message + code) on the thrown error', async () => {
    const client = buildClient({
      fetch: mockFetch(422, { message: 'value out of range', code: 'out_of_range' }),
    });

    try {
      await client.putTenant(TENANT_ID, { region: '' });
      expect.fail('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ManagementApiError);
      expect((err as ManagementApiError).status).toBe(422);
      expect((err as ManagementApiError).responseBody).toEqual({
        message: 'value out of range',
        code: 'out_of_range',
      });
    }
  });
});

describe('ManagementApiClient response handling', () => {
  it('returns undefined for 204 No Content', async () => {
    const client = buildClient({ fetch: mockFetch(204) });

    await expect(client.deleteAccessKey(TENANT_ID, 'AKIA123')).resolves.toBeUndefined();
  });

  it('returns parsed JSON for 2xx responses', async () => {
    const tenant = {
      tenantId: TENANT_ID,
      status: 'active',
      bucketCount: 1,
      bucketLimit: 100,
      accessKeyCount: 2,
      accessKeyLimit: 300,
      createdAt: '2026-01-01T00:00:00Z',
    };
    const client = buildClient({ fetch: mockFetch(201, tenant) });

    const result = await client.putTenant(TENANT_ID, { region: 'us-east-1' });
    expect(result).toEqual(tenant);
  });
});

describe('ManagementApiClient interceptors', () => {
  it('runs request interceptors before fetch', async () => {
    const client = buildClient({ fetch: mockFetch(200, {}) });

    const seen: string[] = [];
    client.interceptors.request.use((req) => {
      seen.push('req');
      return req;
    });

    await client.getTenant(TENANT_ID);
    expect(seen).toEqual(['req']);
  });

  it('runs response interceptors with the original request and path template', async () => {
    const client = buildClient({ fetch: mockFetch(200, {}) });

    const seen: Array<{ status: number; method: string; url: string }> = [];
    client.interceptors.response.use((res, req, opts) => {
      seen.push({ status: res.status, method: req.method, url: opts.url ?? '' });
      return res;
    });

    await client.getTenant(TENANT_ID);
    expect(seen).toEqual([{ status: 200, method: 'GET', url: '/tenants/{tenantId}' }]);
  });

  it('runs error interceptors with undefined response on network failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const client = buildClient({ fetch: fetchMock });

    const seen: Array<{ hasResponse: boolean }> = [];
    client.interceptors.error.use((_err, response) => {
      seen.push({ hasResponse: response !== undefined });
    });

    await expect(client.getTenant(TENANT_ID)).rejects.toBeInstanceOf(TypeError);
    expect(seen).toEqual([{ hasResponse: false }]);
  });

  it('replaces the thrown HTTP error with the value returned from an error interceptor', async () => {
    const client = buildClient({ fetch: mockFetch(500, { message: 'boom' }) });

    const wrapped = new Error('wrapped');
    client.interceptors.error.use(() => wrapped);

    await expect(client.getTenant(TENANT_ID)).rejects.toBe(wrapped);
  });

  it('keeps the original error when an interceptor returns undefined', async () => {
    const client = buildClient({ fetch: mockFetch(500, { message: 'boom' }) });

    client.interceptors.error.use(() => undefined);

    await expect(client.getTenant(TENANT_ID)).rejects.toMatchObject({
      name: 'ManagementApiError',
      status: 500,
    });
  });

  it('runs interceptors in registration order', async () => {
    const client = buildClient({ fetch: mockFetch(200, {}) });

    const seen: number[] = [];
    client.interceptors.request.use((req) => {
      seen.push(1);
      return req;
    });
    client.interceptors.request.use((req) => {
      seen.push(2);
      return req;
    });

    await client.getTenant(TENANT_ID);
    expect(seen).toEqual([1, 2]);
  });
});

describe('ManagementApiClient endpoint coverage', () => {
  let fetchMock: typeof fetch;
  let client: ManagementApiClient;

  beforeEach(() => {
    fetchMock = mockFetch(200, {});
    client = buildClient({ fetch: fetchMock });
  });

  it('putTenant PUTs the region body to /tenants/{tenantId}', async () => {
    await client.putTenant(TENANT_ID, { region: 'us-east-1' });

    const req = lastRequest(fetchMock);
    expect(req.method).toBe('PUT');
    expect(req.url).toBe(`https://api.example.com/tenants/${TENANT_ID}`);
    expect(await req.json()).toEqual({ region: 'us-east-1' });
  });

  it('deleteTenant sends DELETE', async () => {
    fetchMock = mockFetch(204);
    client = buildClient({ fetch: fetchMock });

    await client.deleteTenant(TENANT_ID);

    const req = lastRequest(fetchMock);
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe(`https://api.example.com/tenants/${TENANT_ID}`);
  });

  it('setTenantStatus POSTs the status body and returns void on 204', async () => {
    fetchMock = mockFetch(204);
    client = buildClient({ fetch: fetchMock });

    const result = await client.setTenantStatus(TENANT_ID, { status: 'write-locked' });

    const req = lastRequest(fetchMock);
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`https://api.example.com/tenants/${TENANT_ID}/status`);
    expect(await req.json()).toEqual({ status: 'write-locked' });
    expect(result).toBeUndefined();
  });

  it('createAccessKey POSTs the full body including bucket scopes and expiry', async () => {
    fetchMock = mockFetch(201, { accessKeyId: 'AK', secretAccessKey: 'SK' });
    client = buildClient({ fetch: fetchMock });

    await client.createAccessKey(TENANT_ID, {
      name: 'k',
      permissions: ['s3:GetObject'],
      buckets: ['my-bucket'],
      expiresAt: null,
    });

    const req = lastRequest(fetchMock);
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`https://api.example.com/tenants/${TENANT_ID}/access-keys`);
    expect(await req.json()).toEqual({
      name: 'k',
      permissions: ['s3:GetObject'],
      buckets: ['my-bucket'],
      expiresAt: null,
    });
  });

  it('createAccessKey omits buckets and expiresAt when not provided', async () => {
    fetchMock = mockFetch(201, { accessKeyId: 'AK', secretAccessKey: 'SK' });
    client = buildClient({ fetch: fetchMock });

    await client.createAccessKey(TENANT_ID, { name: 'k', permissions: ['s3:GetObject'] });

    const req = lastRequest(fetchMock);
    expect(await req.json()).toEqual({ name: 'k', permissions: ['s3:GetObject'] });
  });

  it('listAccessKeys unwraps the items envelope', async () => {
    const key = {
      accessKeyId: 'AK',
      name: 'k',
      permissions: [],
      createdAt: '2026-01-01T00:00:00Z',
    };
    fetchMock = mockFetch(200, { items: [key] });
    client = buildClient({ fetch: fetchMock });

    const result = await client.listAccessKeys(TENANT_ID);

    const req = lastRequest(fetchMock);
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`https://api.example.com/tenants/${TENANT_ID}/access-keys`);
    expect(result).toEqual([key]);
  });

  it('listAccessKeys tolerates a missing items field', async () => {
    fetchMock = mockFetch(200, {});
    client = buildClient({ fetch: fetchMock });

    await expect(client.listAccessKeys(TENANT_ID)).resolves.toEqual([]);
  });

  it('getAccessKey GETs the key by id', async () => {
    await client.getAccessKey(TENANT_ID, 'AKIA-1');

    const req = lastRequest(fetchMock);
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`https://api.example.com/tenants/${TENANT_ID}/access-keys/AKIA-1`);
  });

  it('deleteAccessKey sends DELETE', async () => {
    fetchMock = mockFetch(204);
    client = buildClient({ fetch: fetchMock });

    await client.deleteAccessKey(TENANT_ID, 'AKIA-1');

    const req = lastRequest(fetchMock);
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe(`https://api.example.com/tenants/${TENANT_ID}/access-keys/AKIA-1`);
  });

  it('getTenantMetrics GETs with from/to/window query params', async () => {
    const body: ManagementMetrics = {
      storage: { samples: [{ timestamp: '2026-01-01T01:00:00Z', bytesUsed: 10, objectCount: 1 }] },
      egress: { samples: [{ timestamp: '2026-01-01T01:00:00Z', bytesEgressed: 5 }] },
      ingress: { samples: [{ timestamp: '2026-01-01T01:00:00Z', bytesIngested: 7 }] },
    };
    fetchMock = mockFetch(200, body);
    client = buildClient({ fetch: fetchMock });

    const result = await client.getTenantMetrics(TENANT_ID, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
      window: '1h',
    });

    const req = lastRequest(fetchMock);
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe(`https://api.example.com/tenants/${TENANT_ID}/metrics`);
    expect(url.searchParams.get('from')).toBe('2026-01-01T00:00:00Z');
    expect(url.searchParams.get('to')).toBe('2026-02-01T00:00:00Z');
    expect(url.searchParams.get('window')).toBe('1h');
    expect(result).toEqual(body);
  });

  it('getBucketMetrics GETs the per-bucket path with the same query params', async () => {
    await client.getBucketMetrics(TENANT_ID, 'my-bucket', {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-08T00:00:00Z',
      window: '24h',
    });

    const req = lastRequest(fetchMock);
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe(
      `https://api.example.com/tenants/${TENANT_ID}/buckets/my-bucket/metrics`,
    );
    expect(url.searchParams.get('window')).toBe('24h');
  });
});
