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
/** Status, versions, sync (which returns 202 at once) and drop. */
export const RAG_ENGINE_DEFAULT_TIMEOUT_MS = 8_000;

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

/** The engine answered with a non-2xx status, timed out, or could not be reached. */
export class RagEngineRequestError extends Error {
  /** HTTP status from the engine; absent when the request never got an answer. */
  readonly status?: number;
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RagEngineRequestError';
    this.status = status;
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
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  } catch {
    return undefined;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

/** The value the SST secrets hold until an operator sets them (see sst.config.ts). */
export const RAG_ENGINE_SECRET_PLACEHOLDER = 'unset';

export interface RagEngineClient {
  sync(target: RagEngineTarget): Promise<RagEngineStatus>;
  status(target: RagEngineTarget): Promise<RagEngineStatus>;
  versions(target: RagEngineTarget): Promise<RagEngineVersionsResponse>;
  query(request: RagEngineQueryRequest): Promise<RagEngineQueryResponse>;
  drop(target: RagEngineTarget): Promise<void>;
}

/**
 * A client for the configured engine. Throws {@link RagEngineNotConfiguredError}
 * when the stage has no engine, so callers in Forge regions can answer 503.
 */
export function getRagEngineClient(config = getRagEngineConfig()): RagEngineClient {
  if (!config) throw new RagEngineNotConfiguredError();
  const { baseUrl, token } = config;

  async function post<T>(route: string, body: unknown, timeoutMs: number): Promise<T> {
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
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new RagEngineRequestError(
        timedOut
          ? `Bucket Intelligence engine did not answer /${route} within ${timeoutMs} ms`
          : `Bucket Intelligence engine is unreachable (/${route})`,
        undefined,
        { cause: error },
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new RagEngineRequestError(
        `Bucket Intelligence engine answered /${route} with ${response.status}: ${engineMessage(text)}`,
        response.status,
      );
    }
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
    query: (request) => post('query', request, RAG_ENGINE_QUERY_TIMEOUT_MS),
    drop: async (target) => {
      await post('drop', { target }, RAG_ENGINE_DEFAULT_TIMEOUT_MS);
    },
  };
}

/** The engine's error message, when its body carries one; never the whole body. */
function engineMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    const message = parsed.message ?? parsed.error;
    if (typeof message === 'string') return message.slice(0, 300);
  } catch {
    // Not JSON.
  }
  return text.slice(0, 300) || 'no body';
}

/**
 * The engine request target for a bucket: the bucket identity plus the
 * tenant's Forge S3 credentials from the orchestrator.
 */
export async function ragEngineTarget(
  orchestrator: { getS3ClientContext(tenantId: string): Promise<S3ClientContext> },
  tenantId: string,
  bucket: { orgId: string; region: S3Region; bucketName: string },
): Promise<RagEngineTarget> {
  const ctx = await orchestrator.getS3ClientContext(tenantId);
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
 * engine, 409 when the engine has no dataset for the bucket yet, 502 for any
 * other engine failure. Anything else is rethrown for the error handler.
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
    if (error.status === 404 || error.status === 409) {
      return new ResponseBuilder()
        .status(409)
        .body<ErrorResponse>({
          message:
            'This bucket has not been indexed yet. Queries become available after the first indexing pass completes.',
          code: ApiErrorCode.BUCKET_NOT_INDEXED,
        })
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
  status: RagEngineStatus,
): BucketRagEnablementResponse {
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
 * An enablement response that reports the engine failure as a failed sync, so
 * the bucket page still renders when the engine is down or unconfigured.
 */
export function withEngineFailure(
  response: BucketRagEnablementResponse,
  error: unknown,
): BucketRagEnablementResponse {
  const lastSyncError =
    error instanceof RagEngineNotConfiguredError
      ? 'Bucket Intelligence is not available in this region yet.'
      : 'The Bucket Intelligence engine could not be reached.';
  return { ...response, syncState: 'error', lastSyncError };
}
