// Lightweight, hand-written, Fetch-based client for the Fortilyx (FTH)
// management API. Exposes a Hey-API-style surface so it composes with the
// existing instrumentClient pattern (see fth-api-metrics.ts) but does not
// depend on @hey-api/client-fetch or codegen.

import { createApiError } from './fth-api-errors.ts';

export * from './fth-api-errors.ts';

// Local status union — keeps the low-level client independent of
// service-orchestrator.ts. Matches FTH's TenantStatus enum.
export type FthClientStatus = 'active' | 'write-locked' | 'disabled';

/**
 * Per-request options that never reach the wire. `args` payloads are request
 * bodies, so the signal rides in this trailing bag instead.
 */
export interface FthRequestOptions {
  /** Aborts the request. The caller owns the deadline, see OrchestratorRequestOptions. */
  signal?: AbortSignal;
}

export interface FthManagementClient {
  createClient(args: CreateClientArgs, opts?: FthRequestOptions): Promise<FthClientRecord>;
  getClient(clientRef: string, opts?: FthRequestOptions): Promise<FthClientRecord>;
  updateClientStatus(
    clientRef: string,
    args: { status: FthClientStatus; displayName?: string; idempotencyKey?: string },
    opts?: FthRequestOptions,
  ): Promise<void>;
  // No idempotency key: a repeat DELETE of a resolvable ref already answers
  // 204, and a cached key would replay a 409 instead of retrying it.
  deleteClient(clientRef: string, opts?: FthRequestOptions): Promise<void>;

  createStorageUser(
    clientRef: string,
    args: CreateStorageUserArgs,
    opts?: FthRequestOptions,
  ): Promise<FthStorageUser>;
  listStorageUsers(clientRef: string, opts?: FthRequestOptions): Promise<FthStorageUser[]>;
  getStorageUser(
    clientRef: string,
    userRef: string,
    opts?: FthRequestOptions,
  ): Promise<FthStorageUser>;

  createAccessKey(
    clientRef: string,
    userRef: string,
    args: CreateAccessKeyArgs,
    opts?: FthRequestOptions,
  ): Promise<FthAccessKeyWithSecret>;
  listAccessKeys(clientRef: string, opts?: FthRequestOptions): Promise<FthAccessKey[]>;
  getAccessKey(
    clientRef: string,
    accessKeyId: string,
    opts?: FthRequestOptions,
  ): Promise<FthAccessKey>;
  deleteAccessKey(
    clientRef: string,
    accessKeyId: string,
    opts?: { idempotencyKey?: string } & FthRequestOptions,
  ): Promise<void>;

  getClientMetricsTimeseries(
    clientRef: string,
    query: { from: string; to: string; interval?: string },
    opts?: FthRequestOptions,
  ): Promise<FthMetricsTimeseriesResponse>;

  getClientMetricsCurrent(
    clientRef: string,
    opts?: FthRequestOptions,
  ): Promise<FthMetricsCurrentResponse>;

  interceptors: {
    request: { use(fn: RequestInterceptor): number };
    response: { use(fn: ResponseInterceptor): number };
    error: { use(fn: ErrorInterceptor): number };
  };
}

export interface FthManagementClientConfig {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export function createFthManagementClient(config: FthManagementClientConfig): FthManagementClient {
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

export interface FthClientRecord {
  id: string;
  externalId: string;
  displayName: string;
  status?: string;
  bucketCount?: number;
  bucketLimit?: number;
  accessKeyCount?: number;
  accessKeyLimit?: number;
  createdAt: string;
}

export interface FthStorageUser {
  id: string;
  userCode: string;
  displayName: string;
  email: string;
  role: string;
  createdAt: string;
}

export interface FthAccessKey {
  id?: string;
  accessKeyId: string;
  name: string;
  permissions: string[];
  buckets: string[];
  expiresAt?: string | null;
  createdAt: string;
}

export interface FthMetricsTimeseriesPoint {
  ts?: string;
  usage_avg_bytes?: number;
  usage_peak_bytes?: number;
  object_count_avg?: number;
  object_count_peak?: number;
  billable_byte_seconds?: number;
  billable_object_seconds?: number;
  egress_bytes?: number;
  egress_requests?: number;
}

export interface FthMetricsTimeseriesResponse {
  from?: string;
  to?: string;
  interval?: string;
  clientId?: number;
  clientCode?: string;
  clientName?: string;
  point_count?: number;
  points?: FthMetricsTimeseriesPoint[];
  watermark_at?: string | null;
  is_partial?: boolean;
  source_lag_seconds?: number | null;
}

export interface FthAccessKeyWithSecret extends FthAccessKey {
  secretAccessKey: string;
}

/** One bucket's storage breakdown within a current-snapshot (`by_bucket` entry). */
export interface FthUsageBucketSummary {
  bucket: string;
  tier?: string;
  size?: number;
  count?: number;
}

export interface FthMetricsCurrentResponse {
  as_of?: string;
  clientId?: number;
  clientCode?: string;
  clientName?: string;
  usage?: {
    total_size?: number;
    total_count?: number;
    bucket_count?: number;
    by_bucket?: FthUsageBucketSummary[];
  };
}

interface FthListResponse<T> {
  items: T[];
}

export interface CreateClientArgs {
  externalId: string;
  displayName: string;
  idempotencyKey: string;
}

export interface CreateStorageUserArgs {
  email: string;
  displayName: string;
  userCode: string;
  role: 'storage_user';
  issueS3Credentials: boolean;
  idempotencyKey: string;
}

export interface CreateAccessKeyArgs {
  name: string;
  permissions: string[];
  buckets: string[];
  expiresAt: string | null;
  idempotencyKey: string;
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

// Everything one request needs beyond its method and path. `signal` is the
// caller's deadline; the other three shape the wire request.
interface RequestOpts {
  body?: unknown;
  idempotencyKey?: string;
  query?: URLSearchParams;
  signal?: AbortSignal;
}

function buildHttpRequest(
  ctx: RequestContext,
  method: string,
  path: string,
  opts: RequestOpts,
): Request {
  const headers = new Headers({
    Authorization: `Bearer ${ctx.token}`,
    Accept: 'application/json',
  });
  if (opts.idempotencyKey) headers.set('Idempotency-Key', opts.idempotencyKey);

  const init: RequestInit = { method, headers, signal: opts.signal };
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
  opts?: RequestOpts;
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
    const apiError = createApiError(httpResponse.status, message, responseBody, { method, path });
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
  opts?: RequestOpts,
) => Promise<T>;

function buildEndpointMethods(request: RequestFn): Omit<FthManagementClient, 'interceptors'> {
  return {
    createClient: (args, opts) =>
      request<FthClientRecord>(
        'POST',
        '/management/v1/clients',
        {},
        {
          body: { externalId: args.externalId, displayName: args.displayName },
          idempotencyKey: args.idempotencyKey,
          signal: opts?.signal,
        },
      ),
    getClient: (clientRef, opts) =>
      request<FthClientRecord>(
        'GET',
        '/management/v1/clients/{clientRef}',
        { clientRef },
        { signal: opts?.signal },
      ),
    updateClientStatus: (clientRef, args, opts) =>
      request<void>(
        'PATCH',
        '/management/v1/clients/{clientRef}',
        { clientRef },
        {
          body: {
            status: args.status,
            ...(args.displayName !== undefined && { displayName: args.displayName }),
          },
          idempotencyKey: args.idempotencyKey,
          signal: opts?.signal,
        },
      ),
    deleteClient: (clientRef, opts) =>
      request<void>(
        'DELETE',
        '/management/v1/clients/{clientRef}',
        { clientRef },
        { signal: opts?.signal },
      ),

    createStorageUser: (clientRef, args, opts) =>
      request<FthStorageUser>(
        'POST',
        '/management/v1/clients/{clientRef}/storage-users',
        { clientRef },
        {
          body: {
            email: args.email,
            displayName: args.displayName,
            userCode: args.userCode,
            role: args.role,
            issueS3Credentials: args.issueS3Credentials,
          },
          idempotencyKey: args.idempotencyKey,
          signal: opts?.signal,
        },
      ),
    listStorageUsers: async (clientRef, opts) => {
      const res = await request<FthListResponse<FthStorageUser>>(
        'GET',
        '/management/v1/clients/{clientRef}/storage-users',
        { clientRef },
        { signal: opts?.signal },
      );
      return res.items ?? [];
    },
    getStorageUser: (clientRef, userRef, opts) =>
      request<FthStorageUser>(
        'GET',
        '/management/v1/clients/{clientRef}/storage-users/{userRef}',
        { clientRef, userRef },
        { signal: opts?.signal },
      ),

    ...buildAccessKeyMethods(request),

    getClientMetricsTimeseries: (clientRef, query, opts) => {
      const params = new URLSearchParams({ from: query.from, to: query.to });
      if (query.interval) params.set('interval', query.interval);
      return request<FthMetricsTimeseriesResponse>(
        'GET',
        '/management/v1/clients/{clientRef}/metrics/timeseries',
        { clientRef },
        { query: params, signal: opts?.signal },
      );
    },
    getClientMetricsCurrent: (clientRef, opts) =>
      request<FthMetricsCurrentResponse>(
        'GET',
        '/management/v1/clients/{clientRef}/metrics/current',
        { clientRef },
        { signal: opts?.signal },
      ),
  };
}

function buildAccessKeyMethods(
  request: RequestFn,
): Pick<
  FthManagementClient,
  'createAccessKey' | 'listAccessKeys' | 'getAccessKey' | 'deleteAccessKey'
> {
  return {
    createAccessKey: (clientRef, userRef, args, opts) =>
      request<FthAccessKeyWithSecret>(
        'POST',
        '/management/v1/clients/{clientRef}/storage-users/{userRef}/access-keys',
        { clientRef, userRef },
        {
          body: {
            name: args.name,
            permissions: args.permissions,
            buckets: args.buckets,
            expiresAt: args.expiresAt,
          },
          idempotencyKey: args.idempotencyKey,
          signal: opts?.signal,
        },
      ),
    listAccessKeys: async (clientRef, opts) => {
      const res = await request<FthListResponse<FthAccessKey>>(
        'GET',
        '/management/v1/clients/{clientRef}/access-keys',
        { clientRef },
        { signal: opts?.signal },
      );
      return res.items ?? [];
    },
    getAccessKey: (clientRef, accessKeyId, opts) =>
      request<FthAccessKey>(
        'GET',
        '/management/v1/clients/{clientRef}/access-keys/{accessKeyId}',
        { clientRef, accessKeyId },
        { signal: opts?.signal },
      ),
    deleteAccessKey: (clientRef, accessKeyId, opts) =>
      request<void>(
        'DELETE',
        '/management/v1/clients/{clientRef}/access-keys/{accessKeyId}',
        { clientRef, accessKeyId },
        { idempotencyKey: opts?.idempotencyKey, signal: opts?.signal },
      ),
  };
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
