// Client for the Bucket Intelligence engine that runs on a Forge appliance
// (FIL-1709). In Forge regions (`usesRagEngine(region)`), indexing and queries
// go to this engine instead of the Lambda + S3 Vectors pipeline. The engine
// holds no AWS credentials and no tenant state: every request names the bucket
// and carries the tenant's Forge S3 credentials (`target.s3`). The wire
// contract lives in `@filone/shared` (`api/rag-engine.ts`).
//
// The engine URL and bearer token come from the `RagEngineUrl` and
// `RagEngineToken` SST secrets, which exist only on non-production stages.
// They are read lazily, so importing this module never touches them.

import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { Resource } from 'sst';
import {
  ApiErrorCode,
  RAG_ENGINE_API_VERSION,
  type BucketRagEnablementResponse,
  type ErrorResponse,
  type RagEngineQueryRequest,
  type RagEngineQueryResponse,
  type RagEngineStatus,
  type RagEngineTarget,
  type RagEngineVersionsResponse,
  type S3Region,
} from '@filone/shared';
import { ResponseBuilder } from './response-builder.ts';
import type { S3ClientContext } from './s3-client.ts';

const LOG = '[rag-engine-client]';

/** Engine answers take 10–20 s; the query route's Lambda and API Gateway allow ~29 s. */
export const RAG_ENGINE_QUERY_TIMEOUT_MS = 27_000;
/**
 * Status, versions, sync (which returns 202 at once) and drop. The engine can
 * be slow to answer while it extracts a large file; the Lambdas allow 15 s.
 */
export const RAG_ENGINE_DEFAULT_TIMEOUT_MS = 12_000;

export interface RagEngineConfig {
  baseUrl: string;
  token: string;
}

/** The engine is not configured on this stage (secrets missing or placeholders). */
export class RagEngineNotConfiguredError extends Error {
  constructor() {
    super('The Bucket Intelligence engine is not configured for this stage.');
    this.name = 'RagEngineNotConfiguredError';
  }
}

/**
 * Error codes the engine sends in `{ error: { code, message } }` that the
 * console answers differently from a generic engine failure. The engine keeps
 * these codes stable; its messages for them name no tenant data or secret.
 */
export const RagEngineErrorCode = {
  /** No dataset exists for the bucket yet. */
  NOT_INDEXED: 'NOT_INDEXED',
  /** The requested dataset version does not exist (pruned, or never written). */
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',
  /** Full-text or hybrid search on a version that predates the full-text index. */
  NO_FULLTEXT_INDEX: 'NO_FULLTEXT_INDEX',
  /** Phrase search on a version whose full-text index is being rebuilt. */
  NO_PHRASE_INDEX: 'NO_PHRASE_INDEX',
  /** Forge storage refused the tenant's key when the engine read the bucket. */
  S3_ACCESS_DENIED: 'S3_ACCESS_DENIED',
  /** Vector or hybrid search on an index built with another embedding model. */
  EMBEDDING_MODEL_CHANGED: 'EMBEDDING_MODEL_CHANGED',
  /** A sync asked for while the bucket's dataset is being dropped. */
  DROP_IN_PROGRESS: 'DROP_IN_PROGRESS',
} as const;

/** What the browser sees for a failed engine sync; the engine's own text goes to the log. */
export const RAG_ENGINE_SYNC_FAILED_MESSAGE = 'The last indexing run failed. Try Index now again.';

/** What the browser sees when Forge storage refused the tenant's key to the engine. */
export const RAG_ENGINE_ACCESS_DENIED_MESSAGE =
  "The Bucket Intelligence engine could not read this bucket with your organization's storage key.";

/** The engine answered with a non-2xx status, timed out, or could not be reached. */
export class RagEngineRequestError extends Error {
  /** HTTP status from the engine; absent when the request never got an answer. */
  readonly status?: number;
  /** The engine's error code (`error.code` in its body), when it sent one. */
  readonly code?: string;
  /** The engine's own error message (`error.message`), when it sent one. */
  readonly engineMessage?: string;
  constructor(
    message: string,
    status?: number,
    options?: { cause?: unknown; code?: string; engineMessage?: string },
  ) {
    super(message, options);
    this.name = 'RagEngineRequestError';
    this.status = status;
    this.code = options?.code;
    this.engineMessage = options?.engineMessage;
  }
}

function readSecret(read: () => string | undefined): string | undefined {
  try {
    return read();
  } catch {
    // SST throws when a resource is not linked to this function (production).
    return undefined;
  }
}

/**
 * The engine's URL and token, or undefined when this stage has none. The SST
 * secrets carry a placeholder until an operator sets them, so anything that is
 * not an http(s) URL counts as unset.
 */
export function getRagEngineConfig(): RagEngineConfig | undefined {
  const baseUrl = readSecret(() => Resource.RagEngineUrl.value)?.trim();
  const token = readSecret(() => Resource.RagEngineToken.value)?.trim();
  if (!baseUrl || !token || token === RAG_ENGINE_SECRET_PLACEHOLDER) return undefined;
  try {
    const url = new URL(baseUrl);
    // The engine token and every tenant's Forge secret key travel in these
    // requests, so plain http is accepted only for a local engine.
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
      console.warn(`${LOG} RagEngineUrl must be https (http only for a local engine); ignoring it`);
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === 'host.docker.internal'
  );
}

/** The value the SST secrets hold until an operator sets them (see sst.config.ts). */
export const RAG_ENGINE_SECRET_PLACEHOLDER = 'unset';

export interface RagEngineClient {
  sync(target: RagEngineTarget): Promise<RagEngineStatus>;
  status(target: RagEngineTarget): Promise<RagEngineStatus>;
  versions(target: RagEngineTarget): Promise<RagEngineVersionsResponse>;
  /**
   * `signal` is the caller's request deadline: the query stops at whichever
   * comes first, it or {@link RAG_ENGINE_QUERY_TIMEOUT_MS}.
   */
  query(
    request: RagEngineQueryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<RagEngineQueryResponse>;
  drop(target: RagEngineTarget): Promise<void>;
}

/**
 * A client for the configured engine. Throws {@link RagEngineNotConfiguredError}
 * when the stage has no engine, so callers in Forge regions can answer 503.
 */
export function getRagEngineClient(config = getRagEngineConfig()): RagEngineClient {
  if (!config) throw new RagEngineNotConfiguredError();
  const { baseUrl, token } = config;

  async function post<T>(
    route: string,
    body: unknown,
    timeoutMs: number,
    deadline?: AbortSignal,
  ): Promise<T> {
    const url = `${baseUrl}/${RAG_ENGINE_API_VERSION}/${route}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        // Every body carries the tenant's Forge secret key, and fetch would
        // replay it to whatever origin a 307/308 names: refuse redirects.
        redirect: 'error',
        signal: requestSignal(timeoutMs, deadline),
      });
    } catch (error) {
      throw new RagEngineRequestError(
        fetchFailureMessage(route, timeoutMs, error, deadline),
        undefined,
        { cause: error },
      );
    }

    // The timeout signal also aborts the body stream, and a connection can
    // reset mid-body; both are engine failures, not unclassified errors.
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new RagEngineRequestError(
        `Bucket Intelligence engine response for /${route} could not be read`,
        response.status,
        { cause: error },
      );
    }
    if (!response.ok) throw engineStatusError(route, response.status, text);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new RagEngineRequestError(
        `Bucket Intelligence engine sent invalid JSON for /${route}`,
        response.status,
        { cause: error },
      );
    }
  }

  return {
    sync: (target) => post('sync', { target }, RAG_ENGINE_DEFAULT_TIMEOUT_MS),
    status: (target) => post('status', { target }, RAG_ENGINE_DEFAULT_TIMEOUT_MS),
    versions: (target) => post('versions', { target }, RAG_ENGINE_DEFAULT_TIMEOUT_MS),
    query: (request, options) =>
      post('query', request, RAG_ENGINE_QUERY_TIMEOUT_MS, options?.signal),
    drop: async (target) => {
      await post('drop', { target }, RAG_ENGINE_DEFAULT_TIMEOUT_MS);
    },
  };
}

/** Aborts at the request's own timeout, or at the caller's deadline when one comes first. */
/** Names the limit that stopped a request: the caller's deadline or the client's own timeout. */
function fetchFailureMessage(
  route: string,
  timeoutMs: number,
  error: unknown,
  deadline: AbortSignal | undefined,
): string {
  if (deadline?.aborted) {
    return `Bucket Intelligence engine did not answer /${route} before the request deadline`;
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `Bucket Intelligence engine did not answer /${route} within ${timeoutMs} ms`;
  }
  return `Bucket Intelligence engine is unreachable (/${route})`;
}

function requestSignal(timeoutMs: number, deadline: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return deadline ? AbortSignal.any([timeout, deadline]) : timeout;
}

/** The error for a non-2xx engine answer, carrying the engine's code and message. */
function engineStatusError(route: string, status: number, text: string): RagEngineRequestError {
  const { code, message } = engineError(text);
  const label = code ? `${status} ${code}` : String(status);
  const detail = message ?? (text.slice(0, 300) || 'no body');
  return new RagEngineRequestError(
    `Bucket Intelligence engine answered /${route} with ${label}: ${detail}`,
    status,
    { code, engineMessage: message },
  );
}

/**
 * The code and message from the engine's error body,
 * `{ error: { code, message } }`. Either is undefined when the body is not
 * that shape (a proxy's error page, for example).
 */
function engineError(text: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const code = parsed?.error?.code;
    const message = parsed?.error?.message;
    return {
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof message === 'string' ? { message: message.slice(0, 300) } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * The engine request target for a bucket: the bucket identity plus the
 * tenant's Forge S3 credentials from the orchestrator.
 */
export async function ragEngineTarget(
  orchestrator: {
    getS3ClientContext(tenantId: string, region: S3Region): Promise<S3ClientContext>;
  },
  tenantId: string,
  bucket: { orgId: string; region: S3Region; bucketName: string },
): Promise<RagEngineTarget> {
  // The credentials are for the region holding the bucket: a network serves
  // several, and only that region's gateway knows it.
  const ctx = await orchestrator.getS3ClientContext(tenantId, bucket.region);
  return {
    orgId: bucket.orgId,
    region: bucket.region,
    bucketName: bucket.bucketName,
    s3: {
      endpointUrl: ctx.endpointUrl,
      region: ctx.region,
      accessKeyId: ctx.credentials.accessKeyId,
      secretAccessKey: ctx.credentials.secretAccessKey,
    },
  };
}

/**
 * The console response for an engine failure: 503 when the stage has no
 * engine; 409 BUCKET_NOT_INDEXED when the engine has no dataset for the bucket
 * yet; 404 when the requested version is gone; 409 with the engine's message
 * when the version has no full-text index; 409 when the phrase index is being
 * rebuilt; 409 when the index was built with another embedding model or is
 * being removed; 502 with an access message when Forge storage refused the tenant's
 * key; 502 for any other engine failure,
 * including a 404 from a wrong engine URL. Anything else is rethrown for the
 * error handler.
 */
export function ragEngineErrorResponse(error: unknown): APIGatewayProxyStructuredResultV2 {
  if (error instanceof RagEngineNotConfiguredError) {
    return new ResponseBuilder()
      .status(503)
      .body<ErrorResponse>({
        message: 'Bucket Intelligence is not available in this region yet.',
      })
      .build();
  }
  if (error instanceof RagEngineRequestError) {
    console.error(`${LOG} engine request failed`, { message: error.message, status: error.status });
    switch (error.code) {
      case RagEngineErrorCode.NOT_INDEXED:
        return new ResponseBuilder()
          .status(409)
          .body<ErrorResponse>({
            message:
              'This bucket has not been indexed yet. Queries become available after the first indexing pass completes.',
            code: ApiErrorCode.BUCKET_NOT_INDEXED,
          })
          .build();
      case RagEngineErrorCode.VERSION_NOT_FOUND:
        return new ResponseBuilder()
          .status(404)
          .body<ErrorResponse>({
            message: 'That index version is no longer available. Choose another version.',
          })
          .build();
      case RagEngineErrorCode.NO_FULLTEXT_INDEX:
        return new ResponseBuilder()
          .status(409)
          .body<ErrorResponse>({
            message:
              'This index version has no full-text index. Search a later version or use vector search.',
          })
          .build();
      case RagEngineErrorCode.NO_PHRASE_INDEX:
        return new ResponseBuilder()
          .status(409)
          .body<ErrorResponse>({
            message:
              'The full-text index for this bucket is being rebuilt. Run Index now, then search again.',
          })
          .build();
      case RagEngineErrorCode.EMBEDDING_MODEL_CHANGED:
        return new ResponseBuilder()
          .status(409)
          .body<ErrorResponse>({
            message:
              'This index was built with a different embedding model. Run Index now to rebuild it, or use full-text search.',
          })
          .build();
      case RagEngineErrorCode.DROP_IN_PROGRESS:
        return new ResponseBuilder()
          .status(409)
          .body<ErrorResponse>({
            message: "This bucket's index is being removed. Try again in a minute.",
          })
          .build();
      case RagEngineErrorCode.S3_ACCESS_DENIED:
        return new ResponseBuilder()
          .status(502)
          .body<ErrorResponse>({ message: RAG_ENGINE_ACCESS_DENIED_MESSAGE })
          .build();
    }
    return new ResponseBuilder()
      .status(502)
      .body<ErrorResponse>({
        message: 'The Bucket Intelligence engine could not complete the request.',
      })
      .build();
  }
  throw error;
}

/**
 * An enablement response with the sync telemetry replaced by the engine's: in
 * Forge regions the engine, not the DynamoDB row, knows how far indexing got.
 * Enablement (`enabled`, `status`) stays the row's.
 */
export function withEngineStatus(
  response: BucketRagEnablementResponse,
  engineStatus: RagEngineStatus,
): BucketRagEnablementResponse {
  const status = browserSafeEngineStatus(engineStatus);
  return {
    enabled: response.enabled,
    status: response.status,
    syncState: status.syncState,
    filesIndexed: status.filesIndexed,
    indexSize: status.indexedBytes,
    ...(status.lastSyncedAt ? { lastSyncedAt: status.lastSyncedAt } : {}),
    ...(status.syncState === 'error' && status.lastSyncError
      ? { lastSyncError: status.lastSyncError }
      : {}),
  };
}

/**
 * The engine's status with `lastSyncError` replaced by fixed text. The engine
 * stores a failed reconcile's raw exception message, which can name internal
 * hosts and companion paths; that text is logged here and never returned.
 */
export function browserSafeEngineStatus(status: RagEngineStatus): RagEngineStatus {
  if (!status.lastSyncError) return status;
  console.warn(`${LOG} engine reports a failed sync`, { lastSyncError: status.lastSyncError });
  return { ...status, lastSyncError: RAG_ENGINE_SYNC_FAILED_MESSAGE };
}

/**
 * An enablement response that reports the engine failure as a failed sync, so
 * the bucket page still renders when the engine is down or unconfigured. An
 * access denial gets the same text the engine view shows for it.
 */
export function withEngineFailure(
  response: BucketRagEnablementResponse,
  error: unknown,
): BucketRagEnablementResponse {
  let lastSyncError = 'The Bucket Intelligence engine could not be reached.';
  if (error instanceof RagEngineNotConfiguredError) {
    lastSyncError = 'Bucket Intelligence is not available in this region yet.';
  } else if (
    error instanceof RagEngineRequestError &&
    error.code === RagEngineErrorCode.S3_ACCESS_DENIED
  ) {
    lastSyncError = RAG_ENGINE_ACCESS_DENIED_MESSAGE;
  }
  return { ...response, syncState: 'error', lastSyncError };
}
