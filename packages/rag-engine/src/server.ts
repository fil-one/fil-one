import crypto from 'node:crypto';
import http from 'node:http';

import {
  RagEngineQueryRequestSchema,
  RagEngineTargetRequestSchema,
  type RagEngineTarget,
  type RagEngineVersionsResponse,
} from '@filone/shared';
import type { z } from 'zod';

import type { EngineContext } from './engine-context.ts';
import {
  EngineError,
  errorLogFields,
  storageErrorFor,
  summarizeError,
  type EngineErrorBody,
} from './errors.ts';
import { dropTable } from './lance-store.ts';
import { runQuery } from './query.ts';
import { buildStatus, listVersions, memoryStatus } from './status.ts';
import {
  STATE_KEY,
  companionBucketName,
  createS3Client,
  deleteObject,
  storageFor,
  tryDeleteBucket,
} from './storage.ts';
import type { SyncManager } from './sync.ts';

const MAX_BODY_BYTES = 1024 * 1024;

/** Response of `POST /v1/drop`. */
export interface RagEngineDropResponse {
  dropped: boolean;
}

interface Reply {
  status: number;
  body: unknown;
}

type RouteHandler = (body: unknown) => Promise<Reply>;

/** Constant-time comparison of the presented bearer token with the configured one. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  const presented = /^Bearer (.+)$/.exec(header ?? '')?.[1] ?? '';
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b) && presented.length > 0;
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const error = new EngineError(400, 'BAD_REQUEST', 'Request body is invalid');
    Object.assign(error, { issues: result.error.issues });
    throw error;
  }
  return result.data;
}

function targetOf(body: unknown): RagEngineTarget {
  return parse(RagEngineTargetRequestSchema, body).target;
}

async function drop(ctx: EngineContext, syncs: SyncManager, target: RagEngineTarget) {
  const companion = companionBucketName(target.orgId, target.region, target.bucketName);
  await syncs.cancel(companion);
  const storage = storageFor(target, ctx.config.s3EndpointOverrides);
  const dropped = await dropTable(storage, companion);
  const s3 = createS3Client(storage);
  try {
    await deleteObject(s3, companion, STATE_KEY);
    await tryDeleteBucket(s3, companion);
  } finally {
    s3.destroy();
  }
  const response: RagEngineDropResponse = { dropped };
  return response;
}

/**
 * `buildStatus`, with a storage failure that has a known cause (a wrong or
 * rotated tenant key, a missing bucket) reported as that cause, not a 500.
 */
async function statusOrMappedError(
  ctx: EngineContext,
  syncs: SyncManager,
  target: RagEngineTarget,
) {
  try {
    return await buildStatus(ctx, syncs, target);
  } catch (error) {
    const mapped = storageErrorFor(error);
    if (!mapped) throw error;
    ctx.log('warn', 'status_failed', { code: mapped.code, ...errorLogFields(error) });
    throw mapped;
  }
}

function routes(ctx: EngineContext, syncs: SyncManager): Record<string, RouteHandler> {
  return {
    '/v1/sync': async (body) => {
      const target = targetOf(body);
      const started = syncs.start(target);
      // The sync is running whatever happens next, so the caller hears 202.
      // When the status cannot be read (a wrong key fails the same way the
      // sync will), the reply carries what the engine holds in memory.
      try {
        return { status: 202, body: await buildStatus(ctx, syncs, target) };
      } catch (error) {
        ctx.log('warn', 'sync_status_failed', { ...targetFields(body), ...errorLogFields(error) });
        return { status: 202, body: memoryStatus(started) };
      }
    },
    '/v1/status': async (body) => ({
      status: 200,
      body: await statusOrMappedError(ctx, syncs, targetOf(body)),
    }),
    '/v1/versions': async (body) => {
      const response: RagEngineVersionsResponse = {
        versions: await listVersions(ctx, targetOf(body)),
      };
      return { status: 200, body: response };
    },
    '/v1/query': async (body) => ({
      status: 200,
      body: await runQuery(ctx, parse(RagEngineQueryRequestSchema, body)),
    }),
    '/v1/drop': async (body) => ({
      status: 200,
      body: await drop(ctx, syncs, targetOf(body)),
    }),
  };
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new EngineError(413, 'BODY_TOO_LARGE', 'Body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new EngineError(400, 'BAD_JSON', 'Body is not valid JSON');
  }
}

function send(res: http.ServerResponse, reply: Reply): void {
  const payload = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function errorReply(ctx: EngineContext, error: unknown, path: string): Reply {
  if (error instanceof EngineError) {
    const body: EngineErrorBody = {
      error: { code: error.code, message: error.message },
    };
    const issues = (error as EngineError & { issues?: unknown }).issues;
    if (issues) body.error.issues = issues;
    return { status: error.status, body };
  }
  // The full error stays in the log; the caller gets a short summary.
  ctx.log('error', 'request_failed', { path, ...errorLogFields(error) });
  const body: EngineErrorBody = {
    error: { code: 'INTERNAL', message: summarizeError(error) },
  };
  return { status: 500, body };
}

/** Log fields that identify the target without its credentials. */
function targetFields(body: unknown): Record<string, unknown> {
  const target = (body as { target?: Partial<RagEngineTarget> } | undefined)?.target;
  return target ? { orgId: target.orgId, region: target.region, bucket: target.bucketName } : {};
}

/**
 * The path of a request target, without parsing it as a URL: an absolute-form
 * target with a bad port or host must not throw before authentication.
 */
export function requestPath(url: string | undefined): string {
  const target = url ?? '/';
  const path = target.startsWith('/')
    ? target
    : target.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  return path.split(/[?#]/)[0] || '/';
}

async function handle(
  ctx: EngineContext,
  table: Record<string, RouteHandler>,
  req: http.IncomingMessage,
): Promise<{ reply: Reply; body?: unknown }> {
  const path = requestPath(req.url);
  if (req.method === 'GET' && path === '/healthz')
    return { reply: { status: 200, body: { ok: true } } };
  const route = Object.hasOwn(table, path) ? table[path] : undefined;
  if (!route)
    return {
      reply: {
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'No such route' } },
      },
    };
  if (req.method !== 'POST') {
    return {
      reply: {
        status: 405,
        body: { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST' } },
      },
    };
  }
  if (!isAuthorized(req.headers.authorization, ctx.config.token)) {
    return {
      reply: {
        status: 401,
        body: { error: { code: 'UNAUTHORIZED', message: 'Bad token' } },
      },
    };
  }
  let body: unknown;
  try {
    body = await readJson(req);
    return { reply: await route(body), body };
  } catch (error) {
    return { reply: errorReply(ctx, error, path), body };
  }
}

export function createEngineServer(ctx: EngineContext, syncs: SyncManager): http.Server {
  const table = routes(ctx, syncs);
  return http.createServer((req, res) => {
    const started = performance.now();
    handle(ctx, table, req)
      .then(({ reply, body }) => {
        send(res, reply);
        if (req.url !== '/healthz') {
          ctx.log('info', 'request', {
            method: req.method,
            path: requestPath(req.url),
            status: reply.status,
            ms: Math.round(performance.now() - started),
            ...targetFields(body),
          });
        }
      })
      .catch((error: unknown) => {
        // Nothing a request does may take the process down.
        ctx.log('error', 'request_crashed', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          send(res, {
            status: 500,
            body: { error: { code: 'INTERNAL', message: 'Internal error' } },
          });
        } else {
          res.destroy();
        }
      });
  });
}
