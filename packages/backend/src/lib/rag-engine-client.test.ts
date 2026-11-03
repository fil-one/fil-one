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

  it('is undefined for a plain-http URL to a remote host', () => {
    secrets.RagEngineUrl = { value: 'http://s3.eu-central-3.staging.filonecontent.com/_rag' };
    secrets.RagEngineToken = { value: 'engine-token' };
    expect(getRagEngineConfig()).toBeUndefined();
  });

  it.each(['http://127.0.0.1:8090', 'http://localhost:8090', 'http://host.docker.internal:8090'])(
    'accepts plain http for a local engine (%s)',
    (url) => {
      secrets.RagEngineUrl = { value: url };
      secrets.RagEngineToken = { value: 'engine-token' };
      expect(getRagEngineConfig()).toStrictEqual({ baseUrl: url, token: 'engine-token' });
    },
  );

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

  it('throws RagEngineRequestError with the engine’s status, code and message on a non-2xx', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'NO_FULLTEXT_INDEX',
          message: 'This dataset version has no full-text index',
        },
      }),
    );

    const error = await getRagEngineClient(CONFIG)
      .query({ target: TARGET, query: 'q', topK: 5, searchMode: 'hybrid', answer: true })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RagEngineRequestError);
    expect((error as RagEngineRequestError).status).toBe(409);
    expect((error as RagEngineRequestError).code).toBe('NO_FULLTEXT_INDEX');
    expect((error as RagEngineRequestError).engineMessage).toBe(
      'This dataset version has no full-text index',
    );
    expect((error as Error).message).toContain('no full-text index');
  });

  it('leaves the code undefined for a body that is not the engine’s error shape', async () => {
    fetchMock.mockResolvedValue(new Response('<html>404 Not Found</html>', { status: 404 }));

    const error = await getRagEngineClient(CONFIG)
      .status(TARGET)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RagEngineRequestError);
    expect((error as RagEngineRequestError).status).toBe(404);
    expect((error as RagEngineRequestError).code).toBeUndefined();
    expect((error as Error).message).toContain('404 Not Found');
  });

  it('wraps a response body that fails mid-read in RagEngineRequestError', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new TypeError('terminated'));
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));

    const error = await getRagEngineClient(CONFIG)
      .status(TARGET)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RagEngineRequestError);
    expect(ragEngineErrorResponse(error).statusCode).toBe(502);
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

  function engineError(status: number, code?: string) {
    return new RagEngineRequestError('x', status, { code, engineMessage: 'engine text' });
  }

  it('answers 409 BUCKET_NOT_INDEXED for the engine’s NOT_INDEXED', () => {
    const response = ragEngineErrorResponse(engineError(409, 'NOT_INDEXED'));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body as string).code).toBe(ApiErrorCode.BUCKET_NOT_INDEXED);
  });

  it('answers 404 with a version message for VERSION_NOT_FOUND', () => {
    const response = ragEngineErrorResponse(engineError(404, 'VERSION_NOT_FOUND'));
    const body = JSON.parse(response.body as string);
    expect(response.statusCode).toBe(404);
    expect(body.code).toBeUndefined();
    expect(body.message).toContain('version is no longer available');
  });

  it('answers 409 with a full-text message, not BUCKET_NOT_INDEXED, for NO_FULLTEXT_INDEX', () => {
    const response = ragEngineErrorResponse(engineError(409, 'NO_FULLTEXT_INDEX'));
    const body = JSON.parse(response.body as string);
    expect(response.statusCode).toBe(409);
    expect(body.code).toBeUndefined();
    expect(body.message).toContain('no full-text index');
  });

  it.each([
    ['a route 404', 404, 'NOT_FOUND'],
    ['a non-JSON 404 (wrong engine URL)', 404, undefined],
    ['a 409 without a code', 409, undefined],
    ['a 500', 500, 'INTERNAL'],
  ])('answers 502 for %s', (_name, status, code) => {
    expect(ragEngineErrorResponse(engineError(status, code)).statusCode).toBe(502);
  });

  it('answers 502 when the engine never answered', () => {
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
