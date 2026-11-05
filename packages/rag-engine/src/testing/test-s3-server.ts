// A minimal path-style S3-compatible server backed by a temp directory, for
// tests. Ported from the Lance spike (PR #523) and extended with bucket
// semantics (CreateBucket, HeadBucket, NoSuchBucket), content ETags in
// listings, and optional SigV4 credential checks.
//
// It exercises the same `s3://` code path a Forge gateway serves, records every
// request, and can refuse conditional writes, the S3 feature Lance needs for
// every commit.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export interface S3Request {
  op: string;
  bucket: string;
  key?: string;
  bytes?: number;
  ranged?: boolean;
  conditional?: string;
  status?: number;
  /** The `x-amz-security-token` header, when the request carried one (even empty). */
  securityToken?: string;
}

export interface S3ServerStats {
  requests: S3Request[];
  /** Bytes sent to the client (GET bodies, whole or ranged). */
  bytesOut: number;
  /** Bytes received from the client (PUT and UploadPart bodies). */
  bytesIn: number;
  /** Operations the server deliberately refused, e.g. conditional writes. */
  refused: string[];
}

export interface TestS3Server {
  url: string;
  stats: S3ServerStats;
  /** The live options; tests may change them between requests. */
  options: TestS3ServerOptions;
  reset(): void;
  close(): Promise<void>;
}

export interface TestS3ServerOptions {
  /** Directory backing the server. Created if absent. */
  root: string;
  /** Reject `If-Match`/`If-None-Match` writes with 501, as some providers do. */
  rejectConditionalWrites?: boolean;
  /** When set, requests signed with another access key id get 403. */
  accessKeyId?: string;
  /** Runs before each request is served; the request waits for it to settle. */
  beforeRequest?: (request: {
    method: string;
    bucket: string;
    key: string;
  }) => Promise<void> | void;
}

interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  bucket: string;
  key: string;
  query: URLSearchParams;
  body: Buffer;
  /** Absolute path of the object addressed by (bucket, key). */
  target: string;
  bucketDir: string;
  stats: S3ServerStats;
  options: TestS3ServerOptions;
}

const xmlEscape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const etagOf = (buf: Buffer): string => `"${crypto.createHash('md5').update(buf).digest('hex')}"`;

function xml(ctx: RequestContext, status: number, body: string): void {
  ctx.res.writeHead(status, { 'Content-Type': 'application/xml' });
  ctx.res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
}

function s3Error(ctx: RequestContext, status: number, code: string): void {
  if (ctx.req.method === 'HEAD') {
    ctx.res.writeHead(status);
    ctx.res.end();
    return;
  }
  xml(ctx, status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
}

function record(ctx: RequestContext, entry: Omit<S3Request, 'bucket'>): void {
  const token = ctx.req.headers['x-amz-security-token'];
  ctx.stats.requests.push({
    bucket: ctx.bucket,
    ...entry,
    ...(typeof token === 'string' ? { securityToken: token } : {}),
  });
}

function walk(dir: string, base = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else if (!name.includes('.mpu-part')) out.push(rel);
  }
  return out;
}

function partPath(ctx: RequestContext): string {
  return `${ctx.target}.mpu-part${ctx.query.get('partNumber')}.${ctx.query.get('uploadId')}`;
}

function createMultipartUpload(ctx: RequestContext): void {
  record(ctx, { op: 'CreateMultipartUpload', key: ctx.key });
  xml(
    ctx,
    200,
    `<InitiateMultipartUploadResult><Bucket>${ctx.bucket}</Bucket><Key>${xmlEscape(
      ctx.key,
    )}</Key><UploadId>${crypto.randomUUID()}</UploadId></InitiateMultipartUploadResult>`,
  );
}

function uploadPart(ctx: RequestContext): void {
  record(ctx, { op: 'UploadPart', key: ctx.key, bytes: ctx.body.length });
  const part = partPath(ctx);
  fs.mkdirSync(path.dirname(part), { recursive: true });
  fs.writeFileSync(part, ctx.body);
  ctx.res.writeHead(200, { ETag: etagOf(ctx.body) });
  ctx.res.end();
}

function completeMultipartUpload(ctx: RequestContext): void {
  record(ctx, { op: 'CompleteMultipartUpload', key: ctx.key });
  const dir = path.dirname(ctx.target);
  const prefix = `${path.basename(ctx.target)}.mpu-part`;
  const uploadId = ctx.query.get('uploadId') ?? '';
  const parts = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(uploadId))
    .sort(
      (a, b) =>
        Number(/\.mpu-part(\d+)\./.exec(a)?.[1] ?? 0) -
        Number(/\.mpu-part(\d+)\./.exec(b)?.[1] ?? 0),
    );
  const merged = Buffer.concat(parts.map((f) => fs.readFileSync(path.join(dir, f))));
  fs.writeFileSync(ctx.target, merged);
  for (const f of parts) fs.unlinkSync(path.join(dir, f));
  xml(
    ctx,
    200,
    `<CompleteMultipartUploadResult><Bucket>${
      ctx.bucket
    }</Bucket><Key>${xmlEscape(ctx.key)}</Key><ETag>${etagOf(
      merged,
    )}</ETag></CompleteMultipartUploadResult>`,
  );
}

function deleteObjects(ctx: RequestContext): void {
  const keys = [...ctx.body.toString().matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1] ?? '');
  record(ctx, { op: 'DeleteObjects', bytes: keys.length });
  for (const k of keys) fs.rmSync(path.join(ctx.bucketDir, k), { force: true });
  // Clients validate the per-key <Deleted> entries; an empty <DeleteResult/>
  // fails to deserialize.
  xml(
    ctx,
    200,
    `<DeleteResult>${keys
      .map((k) => `<Deleted><Key>${xmlEscape(k)}</Key></Deleted>`)
      .join('')}</DeleteResult>`,
  );
}

function listEntry(ctx: RequestContext, key: string): string {
  const full = path.join(ctx.bucketDir, key);
  const stat = fs.statSync(full);
  const etag = etagOf(fs.readFileSync(full));
  return `<Contents><Key>${xmlEscape(
    key,
  )}</Key><LastModified>${stat.mtime.toISOString()}</LastModified><ETag>${xmlEscape(
    etag,
  )}</ETag><Size>${stat.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
}

/** ListObjectsV2 with prefix, delimiter, max-keys and continuation tokens. */
function listObjectsV2(ctx: RequestContext): void {
  const prefix = ctx.query.get('prefix') ?? '';
  const delimiter = ctx.query.get('delimiter') ?? '';
  const maxKeys = Number(ctx.query.get('max-keys') ?? 1000);
  const after = ctx.query.get('continuation-token') ?? ctx.query.get('start-after') ?? '';
  record(ctx, { op: 'ListObjectsV2', key: prefix });

  const commonPrefixes = new Set<string>();
  const contents: string[] = [];
  for (const k of walk(ctx.bucketDir).filter((k) => k.startsWith(prefix) && k > after)) {
    const rest = delimiter ? k.slice(prefix.length) : '';
    const idx = delimiter ? rest.indexOf(delimiter) : -1;
    if (idx >= 0) commonPrefixes.add(prefix + rest.slice(0, idx + delimiter.length));
    else contents.push(k);
  }
  const page = contents.slice(0, maxKeys);
  const truncated = contents.length > page.length;
  const next = truncated
    ? `<NextContinuationToken>${xmlEscape(page[page.length - 1] ?? '')}</NextContinuationToken>`
    : '';
  const prefixes = [...commonPrefixes]
    .map((p) => `<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`)
    .join('');

  xml(
    ctx,
    200,
    `<ListBucketResult><Name>${ctx.bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${
      page.length
    }</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${next}${page
      .map((k) => listEntry(ctx, k))
      .join('')}${prefixes}</ListBucketResult>`,
  );
}

function getObject(ctx: RequestContext): void {
  const method = ctx.req.method ?? 'GET';
  if (!fs.existsSync(ctx.target) || fs.statSync(ctx.target).isDirectory()) {
    record(ctx, { op: method, key: ctx.key, status: 404 });
    s3Error(ctx, 404, 'NoSuchKey');
    return;
  }

  const buf = fs.readFileSync(ctx.target);
  const match = ctx.req.headers.range ? /bytes=(\d+)-(\d*)/.exec(ctx.req.headers.range) : null;
  const headers = {
    ETag: etagOf(buf),
    'Last-Modified': fs.statSync(ctx.target).mtime.toUTCString(),
  };
  if (match) {
    const start = Number(match[1]);
    const end = Math.min(match[2] ? Number(match[2]) : buf.length - 1, buf.length - 1);
    const slice = buf.subarray(start, end + 1);
    record(ctx, {
      op: method,
      key: ctx.key,
      ranged: true,
      bytes: slice.length,
    });
    if (method === 'GET') ctx.stats.bytesOut += slice.length;
    ctx.res.writeHead(206, {
      ...headers,
      'Content-Length': slice.length,
      'Content-Range': `bytes ${start}-${end}/${buf.length}`,
    });
    ctx.res.end(method === 'HEAD' ? undefined : slice);
    return;
  }

  record(ctx, { op: method, key: ctx.key, ranged: false, bytes: buf.length });
  if (method === 'GET') ctx.stats.bytesOut += buf.length;
  ctx.res.writeHead(200, { ...headers, 'Content-Length': buf.length });
  ctx.res.end(method === 'HEAD' ? undefined : buf);
}

function putObject(ctx: RequestContext): void {
  const conditional = ctx.req.headers['if-none-match'] ?? ctx.req.headers['if-match'];
  const condition = typeof conditional === 'string' ? conditional : undefined;
  record(ctx, {
    op: 'PUT',
    key: ctx.key,
    bytes: ctx.body.length,
    ...(condition ? { conditional: condition } : {}),
  });

  if (condition && ctx.options.rejectConditionalWrites) {
    ctx.stats.refused.push(`conditional PUT (${condition}) on ${ctx.key}`);
    s3Error(ctx, 501, 'NotImplemented');
    return;
  }
  if (condition === '*' && fs.existsSync(ctx.target)) {
    s3Error(ctx, 412, 'PreconditionFailed');
    return;
  }

  fs.mkdirSync(path.dirname(ctx.target), { recursive: true });
  fs.writeFileSync(ctx.target, ctx.body);
  ctx.res.writeHead(200, { ETag: etagOf(ctx.body) });
  ctx.res.end();
}

function deleteObject(ctx: RequestContext): void {
  record(ctx, { op: 'DELETE', key: ctx.key });
  fs.rmSync(ctx.target, { force: true });
  ctx.res.writeHead(204);
  ctx.res.end();
}

function bucketRequest(ctx: RequestContext, method: string): void {
  if (method === 'PUT') {
    record(ctx, { op: 'CreateBucket' });
    if (fs.existsSync(ctx.bucketDir)) return s3Error(ctx, 409, 'BucketAlreadyOwnedByYou');
    fs.mkdirSync(ctx.bucketDir, { recursive: true });
    ctx.res.writeHead(200);
    ctx.res.end();
    return;
  }
  if (method === 'HEAD') {
    record(ctx, { op: 'HeadBucket' });
    ctx.res.writeHead(200);
    ctx.res.end();
    return;
  }
  if (method === 'GET') return listObjectsV2(ctx);
  unsupported(ctx, method);
}

/** POST sub-resources (`?uploads`, `?uploadId`, `?delete`). */
function dispatchPost(ctx: RequestContext): boolean {
  if (ctx.query.has('uploads')) createMultipartUpload(ctx);
  else if (ctx.query.has('uploadId')) completeMultipartUpload(ctx);
  else if (ctx.query.has('delete')) deleteObjects(ctx);
  else return false;
  return true;
}

function unsupported(ctx: RequestContext, method: string): void {
  record(ctx, { op: `UNSUPPORTED ${method}`, key: ctx.key, status: 501 });
  ctx.stats.refused.push(`${method} ${ctx.req.url ?? ''}`);
  ctx.res.writeHead(501);
  ctx.res.end();
}

function objectRequest(ctx: RequestContext, method: string): void {
  switch (method) {
    case 'POST':
      if (!dispatchPost(ctx)) unsupported(ctx, method);
      return;
    case 'PUT':
      if (ctx.query.has('uploadId')) uploadPart(ctx);
      else putObject(ctx);
      return;
    case 'GET':
    case 'HEAD':
      getObject(ctx);
      return;
    case 'DELETE':
      deleteObject(ctx);
      return;
    default:
      unsupported(ctx, method);
  }
}

/** Access key id from a SigV4 `Authorization` header. */
function signedKeyId(req: http.IncomingMessage): string | undefined {
  return /Credential=([^/]+)\//.exec(req.headers.authorization ?? '')?.[1];
}

/** Route one request to its handler, mirroring the S3 REST API's dispatch. */
function dispatch(ctx: RequestContext): void {
  const method = ctx.req.method ?? 'GET';
  if (ctx.options.accessKeyId && signedKeyId(ctx.req) !== ctx.options.accessKeyId) {
    record(ctx, { op: method, key: ctx.key, status: 403 });
    return s3Error(ctx, 403, 'InvalidAccessKeyId');
  }
  const isBucketRequest = ctx.key === '' && !(method === 'POST' && ctx.query.has('delete'));
  if (isBucketRequest && method === 'PUT') return bucketRequest(ctx, method);
  if (!fs.existsSync(ctx.bucketDir)) {
    record(ctx, { op: method, key: ctx.key, status: 404 });
    return s3Error(ctx, 404, 'NoSuchBucket');
  }
  if (isBucketRequest || ctx.query.get('list-type') === '2') return bucketRequest(ctx, method);
  objectRequest(ctx, method);
}

export async function startTestS3Server(options: TestS3ServerOptions): Promise<TestS3Server> {
  const { root } = options;
  fs.mkdirSync(root, { recursive: true });

  const stats: S3ServerStats = {
    requests: [],
    bytesOut: 0,
    bytesIn: 0,
    refused: [],
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Path-style addressing: /<bucket>/<key...>
    const segments = url.pathname.replace(/^\//, '').split('/').map(decodeURIComponent);
    const bucket = segments.shift() ?? '';
    const key = segments.join('/');
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      stats.bytesIn += body.length;
      const serve = () =>
        dispatch({
          req,
          res,
          bucket,
          key,
          query: url.searchParams,
          body,
          target: path.join(root, bucket, key),
          bucketDir: path.join(root, bucket),
          stats,
          options,
        });
      const hook = options.beforeRequest;
      if (!hook) return serve();
      void Promise.resolve(hook({ method: req.method ?? 'GET', bucket, key })).then(serve);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    stats,
    options,
    reset() {
      stats.requests.length = 0;
      stats.bytesOut = 0;
      stats.bytesIn = 0;
      stats.refused.length = 0;
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
