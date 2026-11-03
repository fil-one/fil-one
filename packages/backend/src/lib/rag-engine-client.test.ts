import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secrets: { RagEngineUrl?: { value: string }; RagEngineToken?: { value: string } } = {};

vi.mock('sst', () => ({
  Resource: new Proxy(
    {},
    {
      get(_target, name: string) {
        const value = (secrets as Record<string, unknown>)[name];
        // SST throws when a resource is not linked to the function.
        if (value === undefined) throw new Error(`"${name}" is not linked`);
        return value;
      },
    },
  ),
}));

import {
  getRagEngineClient,
  getRagEngineConfig,
  ragEngineErrorResponse,
  ragEngineTarget,
  RagEngineNotConfiguredError,
  RagEngineRequestError,
  withEngineFailure,
  withEngineStatus,
} from './rag-engine-client.ts';
import { ApiErrorCode, S3Region, type RagEngineTarget } from '@filone/shared';
import { engineStatus } from '../test/fake-rag-engine.ts';

const TARGET: RagEngineTarget = {
  orgId: 'org-1',
  region: S3Region.EuCentral3,
  bucketName: 'docs',
  s3: {
    endpointUrl: 'https://s3.eu-central-3.test.invalid',
    region: 'eu-central-3',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
  },
};

const CONFIG = { baseUrl: 'https://engine.test.invalid', token: 'engine-token' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('getRagEngineConfig', () => {
  afterEach(() => {
    delete secrets.RagEngineUrl;
    delete secrets.RagEngineToken;
  });

  it('is undefined where the secrets are not linked (production)', () => {
    expect(getRagEngineConfig()).toBeUndefined();
  });

  it('is undefined while the secrets hold their placeholder', () => {
    secrets.RagEngineUrl = { value: 'unset' };
    secrets.RagEngineToken = { value: 'unset' };
    expect(getRagEngineConfig()).toBeUndefined();
  });

  it('is undefined for a URL that is not http(s)', () => {
    secrets.RagEngineUrl = { value: 'ftp://engine.test.invalid' };
    secrets.RagEngineToken = { value: 'engine-token' };
    expect(getRagEngineConfig()).toBeUndefined();
  });

  it('reads the URL without a trailing slash, and the token', () => {
    secrets.RagEngineUrl = { value: 'https://engine.test.invalid/ ' };
    secrets.RagEngineToken = { value: 'engine-token' };
    expect(getRagEngineConfig()).toStrictEqual(CONFIG);
  });
});

describe('getRagEngineClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws RagEngineNotConfiguredError without a configuration', () => {
    expect(() => getRagEngineClient(undefined)).toThrow(RagEngineNotConfiguredError);
  });

  it.each([
    ['sync', 'sync'],
    ['status', 'status'],
    ['versions', 'versions'],
  ] as const)('%s posts the target to /v1/%s with the bearer token', async (method, route) => {
    fetchMock.mockResolvedValue(jsonResponse(200, engineStatus()));

    await getRagEngineClient(CONFIG)[method](TARGET);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://engine.test.invalid/v1/${route}`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer engine-token',
      'content-type': 'application/json',
    });
    expect(JSON.parse(init.body)).toStrictEqual({ target: TARGET });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns the parsed engine status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(202, engineStatus({ syncState: 'syncing' })));

    const status = await getRagEngineClient(CONFIG).sync(TARGET);

    expect(status.syncState).toBe('syncing');
  });

  it('posts a query request as given', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { answer: '', citations: [], sources: [] }));
    const request = {
      target: TARGET,
      query: 'what?',
      topK: 5,
      searchMode: 'hybrid' as const,
      version: 3,
      answer: true,
    };

    await getRagEngineClient(CONFIG).query(request);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://engine.test.invalid/v1/query');
    expect(JSON.parse(init.body)).toStrictEqual(request);
  });

  it('accepts an empty body from drop', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(getRagEngineClient(CONFIG).drop(TARGET)).resolves.toBeUndefined();
  });

  it('throws RagEngineRequestError with the status and engine message on a non-2xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: 'no dataset' }));

    const error = await getRagEngineClient(CONFIG)
      .status(TARGET)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RagEngineRequestError);
    expect((error as RagEngineRequestError).status).toBe(404);
    expect((error as Error).message).toContain('no dataset');
  });

  it('throws RagEngineRequestError without a status when the engine is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const error = await getRagEngineClient(CONFIG)
      .status(TARGET)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RagEngineRequestError);
    expect((error as RagEngineRequestError).status).toBeUndefined();
  });

  it('never puts the tenant secret key in an error message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { message: 'boom' }));

    const error = await getRagEngineClient(CONFIG)
      .status(TARGET)
      .catch((e: unknown) => e);

    expect((error as Error).message).not.toContain('SK');
    expect((error as Error).message).not.toContain('engine-token');
  });
});

describe('ragEngineTarget', () => {
  it('builds the target from the orchestrator S3 context', async () => {
    const orchestrator = {
      getS3ClientContext: vi.fn(async () => ({
        endpointUrl: 'https://s3.eu-central-3.test.invalid',
        region: 'eu-central-3',
        credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
        forcePathStyle: true,
        orchestratorId: 'forge',
        tenantId: 'tenant-1',
      })),
    };

    const target = await ragEngineTarget(orchestrator, 'tenant-1', {
      orgId: 'org-1',
      region: S3Region.EuCentral3,
      bucketName: 'docs',
    });

    expect(orchestrator.getS3ClientContext).toHaveBeenCalledWith('tenant-1');
    expect(target).toStrictEqual(TARGET);
  });
});

describe('ragEngineErrorResponse', () => {
  it('answers 503 when the stage has no engine', () => {
    const response = ragEngineErrorResponse(new RagEngineNotConfiguredError());
    expect(response.statusCode).toBe(503);
  });

  it.each([404, 409])('answers 409 BUCKET_NOT_INDEXED for an engine %s', (status) => {
    const response = ragEngineErrorResponse(new RagEngineRequestError('x', status));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body as string).code).toBe(ApiErrorCode.BUCKET_NOT_INDEXED);
  });

  it('answers 502 for any other engine failure', () => {
    expect(ragEngineErrorResponse(new RagEngineRequestError('x', 500)).statusCode).toBe(502);
    expect(ragEngineErrorResponse(new RagEngineRequestError('x')).statusCode).toBe(502);
  });

  it('rethrows an error that is not the engine’s', () => {
    expect(() => ragEngineErrorResponse(new Error('other'))).toThrow('other');
  });
});

describe('withEngineStatus', () => {
  const base = { enabled: true, status: 'active' as const, filesIndexed: 0, indexSize: 0 };

  it('replaces the telemetry with the engine’s and keeps enablement', () => {
    expect(withEngineStatus(base, engineStatus())).toStrictEqual({
      enabled: true,
      status: 'active',
      syncState: 'idle',
      filesIndexed: 3,
      indexSize: 4096,
      lastSyncedAt: '2026-11-03T10:00:00.000Z',
    });
  });

  it('carries the engine’s error only while it is in error', () => {
    const merged = withEngineStatus(
      base,
      engineStatus({ syncState: 'error', lastSyncError: 'list failed' }),
    );
    expect(merged.syncState).toBe('error');
    expect(merged.lastSyncError).toBe('list failed');
  });

  it('reports an engine failure as a failed sync', () => {
    expect(withEngineFailure(base, new RagEngineRequestError('down'))).toMatchObject({
      enabled: true,
      syncState: 'error',
      lastSyncError: 'The Bucket Intelligence engine could not be reached.',
    });
  });
});
