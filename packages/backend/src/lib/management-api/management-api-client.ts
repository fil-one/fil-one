// Lightweight, hand-written, Fetch-based client for the generic Service
// Orchestrator Management API contract
// (docs/service-orchestrator-integration/management-openapi.yaml). Exposes a
// Hey-API-style surface so it composes with the existing instrumentClient
// pattern (see management-api-metrics.ts) but does not depend on
// @hey-api/client-fetch or codegen.
//
// Unlike the FTH client, this contract has no Idempotency-Key header:
// idempotency is designed into each endpoint (PUT tenant is idempotent on the
// client-supplied tenantId, DELETEs return 204 when already gone, and
// duplicate access-key names return 409 for the caller to recover from).

import { createApiError } from './management-api-errors.js';

export * from './management-api-errors.js';

// Local status union — keeps the low-level client independent of
// service-orchestrator.ts. Matches the contract's TenantStatus enum.
export type ManagementTenantStatus = 'active' | 'write-locked' | 'disabled';

export interface ManagementApiClient {
  /**
   * PUT /tenants/{tenantId} — create and synchronously set up a tenant.
   * Idempotent on the client-supplied UUID: 200 (existing) and 201 (created)
   * both resolve with the tenant.
   */
  putTenant(tenantId: string, args: { region: string }): Promise<ManagementTenant>;
  getTenant(tenantId: string): Promise<ManagementTenant>;
  /** DELETE /tenants/{tenantId} — requires the tenant to be `disabled`; 204 even if already gone. */
  deleteTenant(tenantId: string): Promise<void>;
  /** POST /tenants/{tenantId}/status — setting the same status twice is a no-op. */
  setTenantStatus(tenantId: string, args: { status: ManagementTenantStatus }): Promise<void>;

  createAccessKey(
    tenantId: string,
    args: CreateManagementAccessKeyArgs,
  ): Promise<ManagementCreatedAccessKey>;
  listAccessKeys(tenantId: string): Promise<ManagementAccessKey[]>;
  getAccessKey(tenantId: string, accessKeyId: string): Promise<ManagementAccessKey>;
  /** DELETE — 204 even if the key was already deleted; 404 only when the tenant is missing. */
  deleteAccessKey(tenantId: string, accessKeyId: string): Promise<void>;

  getTenantMetrics(tenantId: string, query: ManagementMetricsQuery): Promise<ManagementMetrics>;
  /** Per-bucket series. The orchestrator verifies bucket ownership and 404s otherwise. */
  getBucketMetrics(
    tenantId: string,
    bucketName: string,
    query: ManagementMetricsQuery,
  ): Promise<ManagementMetrics>;

  interceptors: {
    request: { use(fn: RequestInterceptor): number };
    response: { use(fn: ResponseInterceptor): number };
    error: { use(fn: ErrorInterceptor): number };
  };
}

export interface ManagementApiClientConfig {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export function createManagementApiClient(config: ManagementApiClientConfig): ManagementApiClient {
  const ctx: RequestContext = {
    fetchImpl: config.fetch ?? fetch,
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
    token: config.token,
    requestInterceptors: [],
    responseInterceptors: [],
    errorInterceptors: [],
  };
  const request: RequestFn = (method, pathTemplate, pathParams, opts) =>
    runRequest(ctx, { method, pathTemplate, pathParams, opts });

  return {
    ...buildEndpointMethods(request),
    interceptors: {
      request: {
        use: (fn) => {
          ctx.requestInterceptors.push(fn);
          return ctx.requestInterceptors.length - 1;
        },
      },
      response: {
        use: (fn) => {
          ctx.responseInterceptors.push(fn);
          return ctx.responseInterceptors.length - 1;
        },
      },
      error: {
        use: (fn) => {
          ctx.errorInterceptors.push(fn);
          return ctx.errorInterceptors.length - 1;
        },
      },
    },
  };
}

export interface ManagementTenant {
  tenantId: string;
  status: ManagementTenantStatus;
  bucketCount: number;
  bucketLimit: number;
  /** Includes the per-tenant `filone-console` system key. */
  accessKeyCount: number;
  accessKeyLimit: number;
  createdAt: string;
}

export interface ManagementAccessKey {
  accessKeyId: string;
  name: string;
  /** `s3:`-prefixed IAM action strings from the contract's permission enum. */
  permissions: string[];
  /** Empty or omitted when the key has tenant-wide access. */
  buckets?: string[];
  expiresAt?: string | null;
  createdAt: string;
}

export interface ManagementCreatedAccessKey extends ManagementAccessKey {
  /** Returned only on creation; never exposed by subsequent reads. */
  secretAccessKey: string;
}

export interface CreateManagementAccessKeyArgs {
  name: string;
  permissions: string[];
  /** Omit (or pass an empty array) for tenant-wide access. */
  buckets?: string[];
  expiresAt?: string | null;
}

export interface ManagementMetricsQuery {
  /** Inclusive start, RFC 3339. */
  from: string;
  /** Exclusive end, RFC 3339. */
  to: string;
  /** Sample bucket size as `<integer>h` (contract minimum: 1h, 24h, 720h). */
  window: string;
}

export interface ManagementStorageSample {
  timestamp: string;
  bytesUsed: number;
  objectCount: number;
}

export interface ManagementEgressSample {
  timestamp: string;
  bytesEgressed: number;
}

export interface ManagementIngressSample {
  timestamp: string;
  bytesIngested: number;
}

export interface ManagementMetrics {
  storage: { samples: ManagementStorageSample[] };
  egress: { samples: ManagementEgressSample[] };
  ingress: { samples: ManagementIngressSample[] };
}

interface ManagementListResponse<T> {
  items: T[];
}

type RequestInterceptor = (
  request: Request,
  options: InterceptorOptions,
) => Request | Promise<Request>;

type ResponseInterceptor = (
  response: Response,
  request: Request,
  options: InterceptorOptions,
) => Response | Promise<Response>;

// Returning a non-undefined value replaces the error that will ultimately be
// thrown, matching Hey-API's error-interceptor semantics. Returning undefined
// (including from a `void`-returning callback) keeps the current error.
type ErrorInterceptor = (
  error: unknown,
  response: Response | undefined,
  request: Request,
  options: InterceptorOptions,
) => unknown;

interface InterceptorOptions {
  url?: string;
}

interface RequestContext {
  fetchImpl: typeof fetch;
  baseUrl: string;
  token: string;
  requestInterceptors: RequestInterceptor[];
  responseInterceptors: ResponseInterceptor[];
  errorInterceptors: ErrorInterceptor[];
}

function buildHttpRequest(
  ctx: RequestContext,
  method: string,
  path: string,
  opts: {
    body?: unknown;
    query?: URLSearchParams;
  },
): Request {
  const headers = new Headers({
    Authorization: `Bearer ${ctx.token}`,
    Accept: 'application/json',
  });

  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(opts.body);
  }

  let url = `${ctx.baseUrl}${path}`;
  if (opts.query) {
    const qs = opts.query.toString();
    if (qs) url = `${url}?${qs}`;
  }

  return new Request(url, init);
}

interface RequestSpec {
  method: string;
  pathTemplate: string;
  pathParams: Record<string, string>;
  opts?: {
    body?: unknown;
    query?: URLSearchParams;
  };
}

async function runRequest<T>(
  ctx: RequestContext,
  { method, pathTemplate, pathParams, opts = {} }: RequestSpec,
): Promise<T> {
  const path = renderPath(pathTemplate, pathParams);
  let httpRequest = buildHttpRequest(ctx, method, path, opts);
  const interceptorOpts: InterceptorOptions = { url: pathTemplate };

  for (const fn of ctx.requestInterceptors) {
    httpRequest = await fn(httpRequest, interceptorOpts);
  }

  let httpResponse: Response;
  try {
    httpResponse = await ctx.fetchImpl(httpRequest);
  } catch (err) {
    throw await runErrorInterceptors(ctx, {
      error: err,
      response: undefined,
      request: httpRequest,
      options: interceptorOpts,
    });
  }

  for (const fn of ctx.responseInterceptors) {
    httpResponse = await fn(httpResponse, httpRequest, interceptorOpts);
  }

  if (!httpResponse.ok) {
    const responseBody = await readBodySafe(httpResponse);
    const message = extractErrorMessage(responseBody) ?? httpResponse.statusText;
    const apiError = createApiError(httpResponse.status, message, responseBody);
    throw await runErrorInterceptors(ctx, {
      error: apiError,
      response: httpResponse,
      request: httpRequest,
      options: interceptorOpts,
    });
  }

  if (httpResponse.status === 204) return undefined as T;
  const text = await httpResponse.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

interface ErrorInterceptorParams {
  error: unknown;
  response: Response | undefined;
  request: Request;
  options: InterceptorOptions;
}

async function runErrorInterceptors(
  ctx: RequestContext,
  { error: initialError, response, request, options }: ErrorInterceptorParams,
): Promise<unknown> {
  let error = initialError;
  for (const fn of ctx.errorInterceptors) {
    const result = await fn(error, response, request, options);
    if (result !== undefined) error = result;
  }
  return error;
}

type RequestFn = <T>(
  method: string,
  pathTemplate: string,
  pathParams: Record<string, string>,
  opts?: {
    body?: unknown;
    query?: URLSearchParams;
  },
) => Promise<T>;

function buildEndpointMethods(request: RequestFn): Omit<ManagementApiClient, 'interceptors'> {
  return {
    putTenant: (tenantId, args) =>
      request<ManagementTenant>(
        'PUT',
        '/tenants/{tenantId}',
        { tenantId },
        { body: { region: args.region } },
      ),
    getTenant: (tenantId) => request<ManagementTenant>('GET', '/tenants/{tenantId}', { tenantId }),
    deleteTenant: (tenantId) => request<void>('DELETE', '/tenants/{tenantId}', { tenantId }),
    setTenantStatus: (tenantId, args) =>
      request<void>(
        'POST',
        '/tenants/{tenantId}/status',
        { tenantId },
        { body: { status: args.status } },
      ),

    createAccessKey: (tenantId, args) =>
      request<ManagementCreatedAccessKey>(
        'POST',
        '/tenants/{tenantId}/access-keys',
        { tenantId },
        {
          body: {
            name: args.name,
            permissions: args.permissions,
            ...(args.buckets !== undefined && { buckets: args.buckets }),
            ...(args.expiresAt !== undefined && { expiresAt: args.expiresAt }),
          },
        },
      ),
    listAccessKeys: async (tenantId) => {
      const res = await request<ManagementListResponse<ManagementAccessKey>>(
        'GET',
        '/tenants/{tenantId}/access-keys',
        { tenantId },
      );
      return res.items ?? [];
    },
    getAccessKey: (tenantId, accessKeyId) =>
      request<ManagementAccessKey>('GET', '/tenants/{tenantId}/access-keys/{accessKeyId}', {
        tenantId,
        accessKeyId,
      }),
    deleteAccessKey: (tenantId, accessKeyId) =>
      request<void>('DELETE', '/tenants/{tenantId}/access-keys/{accessKeyId}', {
        tenantId,
        accessKeyId,
      }),

    getTenantMetrics: (tenantId, query) =>
      request<ManagementMetrics>(
        'GET',
        '/tenants/{tenantId}/metrics',
        { tenantId },
        { query: buildMetricsQuery(query) },
      ),
    getBucketMetrics: (tenantId, bucketName, query) =>
      request<ManagementMetrics>(
        'GET',
        '/tenants/{tenantId}/buckets/{bucketName}/metrics',
        { tenantId, bucketName },
        { query: buildMetricsQuery(query) },
      ),
  };
}

function buildMetricsQuery(query: ManagementMetricsQuery): URLSearchParams {
  return new URLSearchParams({ from: query.from, to: query.to, window: query.window });
}

function renderPath(template: string, params: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${name}" for template "${template}"`);
    }
    return encodeURIComponent(value);
  });
}

async function readBodySafe(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return undefined;
  }
}

function extractErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return undefined;
}
