// Lightweight, hand-written, Fetch-based client for the Fortilyx (FTH)
// management API. Exposes a Hey-API-style surface so it composes with the
// existing instrumentClient pattern (see fth-api-metrics.ts) but does not
// depend on @hey-api/client-fetch or codegen.

import { createApiError } from './fth-api-errors.js';

export * from './fth-api-errors.js';

export interface FthManagementClient {
  createClient(args: CreateClientArgs): Promise<FthClientRecord>;
  getClient(clientRef: string): Promise<FthClientRecord>;

  createStorageUser(clientRef: string, args: CreateStorageUserArgs): Promise<FthStorageUser>;
  listStorageUsers(clientRef: string): Promise<FthStorageUser[]>;
  getStorageUser(clientRef: string, userRef: string): Promise<FthStorageUser>;

  createAccessKey(
    clientRef: string,
    userRef: string,
    args: CreateAccessKeyArgs,
  ): Promise<FthAccessKeyWithSecret>;
  listAccessKeys(clientRef: string): Promise<FthAccessKey[]>;
  getAccessKey(clientRef: string, accessKeyId: string): Promise<FthAccessKey>;
  deleteAccessKey(
    clientRef: string,
    accessKeyId: string,
    opts?: { idempotencyKey?: string },
  ): Promise<void>;

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
    runRequest(ctx, method, pathTemplate, pathParams, opts);

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

export interface FthAccessKeyWithSecret extends FthAccessKey {
  secretAccessKey: string;
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

function buildHttpRequest(
  ctx: RequestContext,
  method: string,
  path: string,
  opts: { body?: unknown; idempotencyKey?: string },
): Request {
  const headers = new Headers({
    Authorization: `Bearer ${ctx.token}`,
    Accept: 'application/json',
  });
  if (opts.idempotencyKey) headers.set('Idempotency-Key', opts.idempotencyKey);

  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(opts.body);
  }
  return new Request(`${ctx.baseUrl}${path}`, init);
}

async function runRequest<T>(
  ctx: RequestContext,
  method: string,
  pathTemplate: string,
  pathParams: Record<string, string>,
  opts: { body?: unknown; idempotencyKey?: string } = {},
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
    throw await runErrorInterceptors(ctx, err, undefined, httpRequest, interceptorOpts);
  }

  for (const fn of ctx.responseInterceptors) {
    httpResponse = await fn(httpResponse, httpRequest, interceptorOpts);
  }

  if (!httpResponse.ok) {
    const responseBody = await readBodySafe(httpResponse);
    const message = extractErrorMessage(responseBody) ?? httpResponse.statusText;
    const apiError = createApiError(httpResponse.status, message, responseBody);
    throw await runErrorInterceptors(ctx, apiError, httpResponse, httpRequest, interceptorOpts);
  }

  if (httpResponse.status === 204) return undefined as T;
  const text = await httpResponse.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function runErrorInterceptors(
  ctx: RequestContext,
  initialError: unknown,
  response: Response | undefined,
  request: Request,
  options: InterceptorOptions,
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
  opts?: { body?: unknown; idempotencyKey?: string },
) => Promise<T>;

function buildEndpointMethods(request: RequestFn): Omit<FthManagementClient, 'interceptors'> {
  return {
    createClient: (args) =>
      request<FthClientRecord>(
        'POST',
        '/management/v1/clients',
        {},
        {
          body: { externalId: args.externalId, displayName: args.displayName },
          idempotencyKey: args.idempotencyKey,
        },
      ),
    getClient: (clientRef) =>
      request<FthClientRecord>('GET', '/management/v1/clients/{clientRef}', { clientRef }),

    createStorageUser: (clientRef, args) =>
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
        },
      ),
    listStorageUsers: (clientRef) =>
      request<FthStorageUser[]>('GET', '/management/v1/clients/{clientRef}/storage-users', {
        clientRef,
      }),
    getStorageUser: (clientRef, userRef) =>
      request<FthStorageUser>('GET', '/management/v1/clients/{clientRef}/storage-users/{userRef}', {
        clientRef,
        userRef,
      }),

    createAccessKey: (clientRef, userRef, args) =>
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
        },
      ),
    listAccessKeys: (clientRef) =>
      request<FthAccessKey[]>('GET', '/management/v1/clients/{clientRef}/access-keys', {
        clientRef,
      }),
    getAccessKey: (clientRef, accessKeyId) =>
      request<FthAccessKey>('GET', '/management/v1/clients/{clientRef}/access-keys/{accessKeyId}', {
        clientRef,
        accessKeyId,
      }),
    deleteAccessKey: (clientRef, accessKeyId, opts) =>
      request<void>(
        'DELETE',
        '/management/v1/clients/{clientRef}/access-keys/{accessKeyId}',
        { clientRef, accessKeyId },
        { idempotencyKey: opts?.idempotencyKey },
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
