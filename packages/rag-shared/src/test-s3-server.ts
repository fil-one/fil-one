// A minimal S3-compatible server backed by a temp directory, for tests and for
// the spike benchmark.
//
// Two reasons this exists rather than pointing a client at a local path: it
// exercises the same `s3://` code path production uses, and it records every
// request — so we can see exactly which S3 operations a client requires and
// check that list against what Aurora and FTH actually implement. It can also be
// configured to reject conditional writes, which is the S3 feature compatible
// providers most often lack.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export interface S3Request {
  op: string;
  key?: string;
  bytes?: number;
  ranged?: boolean;
  conditional?: string;
  status?: number;
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
  reset(): void;
  close(): Promise<void>;
}

export interface TestS3ServerOptions {
  /** Directory backing the server. Created if absent. */
  root: string;
  /** Reject `If-Match`/`If-None-Match` writes with 501, as some providers do. */
  rejectConditionalWrites?: boolean;
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
  root: string;
  stats: S3ServerStats;
  rejectConditionalWrites: boolean;
}

const xmlEscape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const etagOf = (buf: Buffer): string => `"${crypto.createHash('md5').update(buf).digest('hex')}"`;

const xml = (ctx: RequestContext, status: number, body: string): void => {
  ctx.res.writeHead(status, { 'Content-Type': 'application/xml' });
  ctx.res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
};

function walk(dir: string, base = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

function partPath(ctx: RequestContext): string {
  return `${ctx.target}.part${ctx.query.get('partNumber')}.${ctx.query.get('uploadId')}`;
}

function createMultipartUpload(ctx: RequestContext): void {
  ctx.stats.requests.push({ op: 'CreateMultipartUpload', key: ctx.key });
  xml(
    ctx,
    200,
    `<InitiateMultipartUploadResult><Bucket>${ctx.bucket}</Bucket><Key>${xmlEscape(ctx.key)}</Key><UploadId>${crypto.randomUUID()}</UploadId></InitiateMultipartUploadResult>`,
  );
}

function uploadPart(ctx: RequestContext): void {
  ctx.stats.requests.push({ op: 'UploadPart', key: ctx.key, bytes: ctx.body.length });
  const part = partPath(ctx);
  fs.mkdirSync(path.dirname(part), { recursive: true });
  fs.writeFileSync(part, ctx.body);
  ctx.res.writeHead(200, { ETag: etagOf(ctx.body) });
  ctx.res.end();
}

function completeMultipartUpload(ctx: RequestContext): void {
  ctx.stats.requests.push({ op: 'CompleteMultipartUpload', key: ctx.key });
  const dir = path.dirname(ctx.target);
  const prefix = `${path.basename(ctx.target)}.part`;
  const uploadId = ctx.query.get('uploadId') ?? '';
  const parts = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(uploadId))
    .sort(
      (a, b) =>
        Number(/\.part(\d+)\./.exec(a)?.[1] ?? 0) - Number(/\.part(\d+)\./.exec(b)?.[1] ?? 0),
    );
  const merged = Buffer.concat(parts.map((f) => fs.readFileSync(path.join(dir, f))));
  fs.writeFileSync(ctx.target, merged);
  for (const f of parts) fs.unlinkSync(path.join(dir, f));
  xml(
    ctx,
    200,
    `<CompleteMultipartUploadResult><Bucket>${ctx.bucket}</Bucket><Key>${xmlEscape(ctx.key)}</Key><ETag>${etagOf(merged)}</ETag></CompleteMultipartUploadResult>`,
  );
}

function deleteObjects(ctx: RequestContext): void {
  const keys = [...ctx.body.toString().matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1] ?? '');
  ctx.stats.requests.push({ op: 'DeleteObjects', bytes: keys.length });
  for (const k of keys) fs.rmSync(path.join(ctx.root, ctx.bucket, k), { force: true });
  // Clients validate the per-key <Deleted> entries; an empty <DeleteResult/>
  // fails to deserialize.
  xml(
    ctx,
    200,
    `<DeleteResult>${keys.map((k) => `<Deleted><Key>${xmlEscape(k)}</Key></Deleted>`).join('')}</DeleteResult>`,
  );
}

function listObjectsV2(ctx: RequestContext): void {
  const prefix = ctx.query.get('prefix') ?? '';
  const delimiter = ctx.query.get('delimiter') ?? '';
  ctx.stats.requests.push({ op: 'ListObjectsV2', key: prefix });

  const commonPrefixes = new Set<string>();
  const contents: string[] = [];
  for (const k of walk(path.join(ctx.root, ctx.bucket)).filter((k) => k.startsWith(prefix))) {
    const rest = delimiter ? k.slice(prefix.length) : '';
    const idx = delimiter ? rest.indexOf(delimiter) : -1;
    if (idx >= 0) commonPrefixes.add(prefix + rest.slice(0, idx + delimiter.length));
    else contents.push(k);
  }

  const entries = contents
    .map((k) => {
      const size = fs.statSync(path.join(ctx.root, ctx.bucket, k)).size;
      return `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${new Date().toISOString()}</LastModified><ETag>&quot;x&quot;</ETag><Size>${size}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
    })
    .join('');
  const prefixes = [...commonPrefixes]
    .map((p) => `<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`)
    .join('');

  xml(
    ctx,
    200,
    `<ListBucketResult><Name>${ctx.bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${contents.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${entries}${prefixes}</ListBucketResult>`,
  );
}

function getObject(ctx: RequestContext): void {
  const method = ctx.req.method ?? 'GET';
  if (!fs.existsSync(ctx.target) || fs.statSync(ctx.target).isDirectory()) {
    ctx.stats.requests.push({ op: method, key: ctx.key, status: 404 });
    xml(ctx, 404, '<Error><Code>NoSuchKey</Code></Error>');
    return;
  }

  const buf = fs.readFileSync(ctx.target);
  const match = ctx.req.headers.range ? /bytes=(\d+)-(\d*)/.exec(ctx.req.headers.range) : null;
  if (match) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : buf.length - 1;
    const slice = buf.subarray(start, end + 1);
    ctx.stats.requests.push({ op: method, key: ctx.key, ranged: true, bytes: slice.length });
    if (method === 'GET') ctx.stats.bytesOut += slice.length;
    ctx.res.writeHead(206, {
      'Content-Length': slice.length,
      'Content-Range': `bytes ${start}-${end}/${buf.length}`,
      ETag: etagOf(buf),
    });
    ctx.res.end(method === 'HEAD' ? undefined : slice);
    return;
  }

  ctx.stats.requests.push({ op: method, key: ctx.key, ranged: false, bytes: buf.length });
  if (method === 'GET') ctx.stats.bytesOut += buf.length;
  ctx.res.writeHead(200, { 'Content-Length': buf.length, ETag: etagOf(buf) });
  ctx.res.end(method === 'HEAD' ? undefined : buf);
}

function putObject(ctx: RequestContext): void {
  const conditional = ctx.req.headers['if-none-match'] ?? ctx.req.headers['if-match'];
  const condition = typeof conditional === 'string' ? conditional : undefined;
  ctx.stats.requests.push({
    op: 'PUT',
    key: ctx.key,
    bytes: ctx.body.length,
    ...(condition ? { conditional: condition } : {}),
  });

  if (condition && ctx.rejectConditionalWrites) {
    ctx.stats.refused.push(`conditional PUT (${condition}) on ${ctx.key}`);
    xml(ctx, 501, '<Error><Code>NotImplemented</Code></Error>');
    return;
  }
  if (condition === '*' && fs.existsSync(ctx.target)) {
    xml(ctx, 412, '<Error><Code>PreconditionFailed</Code></Error>');
    return;
  }

  fs.mkdirSync(path.dirname(ctx.target), { recursive: true });
  fs.writeFileSync(ctx.target, ctx.body);
  ctx.res.writeHead(200, { ETag: etagOf(ctx.body) });
  ctx.res.end();
}

function deleteObject(ctx: RequestContext): void {
  ctx.stats.requests.push({ op: 'DELETE', key: ctx.key });
  fs.rmSync(ctx.target, { force: true });
  ctx.res.writeHead(204);
  ctx.res.end();
}

/** POST sub-resources (`?uploads`, `?uploadId`, `?delete`). */
function dispatchPost(ctx: RequestContext): boolean {
  if (ctx.query.has('uploads')) createMultipartUpload(ctx);
  else if (ctx.query.has('uploadId')) completeMultipartUpload(ctx);
  else if (ctx.query.has('delete')) deleteObjects(ctx);
  else return false;
  return true;
}

/** A GET is a listing when it carries `list-type=2` or addresses the bucket root. */
function isListRequest(ctx: RequestContext): boolean {
  return ctx.query.get('list-type') === '2' || ctx.key === '';
}

function unsupported(ctx: RequestContext, method: string): void {
  ctx.stats.requests.push({ op: `UNSUPPORTED ${method}`, key: ctx.key, status: 501 });
  ctx.stats.refused.push(`${method} ${ctx.req.url ?? ''}`);
  ctx.res.writeHead(501);
  ctx.res.end();
}

/** Route one request to its handler, mirroring the S3 REST API's dispatch. */
function dispatch(ctx: RequestContext): void {
  const method = ctx.req.method ?? 'GET';

  switch (method) {
    case 'POST':
      if (!dispatchPost(ctx)) unsupported(ctx, method);
      return;
    case 'PUT':
      if (ctx.query.has('uploadId')) uploadPart(ctx);
      else putObject(ctx);
      return;
    case 'GET':
      if (isListRequest(ctx)) listObjectsV2(ctx);
      else getObject(ctx);
      return;
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

export async function startTestS3Server(options: TestS3ServerOptions): Promise<TestS3Server> {
  const { root, rejectConditionalWrites = false } = options;
  fs.mkdirSync(root, { recursive: true });

  const stats: S3ServerStats = { requests: [], bytesOut: 0, bytesIn: 0, refused: [] };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Path-style addressing: /<bucket>/<key...>
    const segments = url.pathname.replace(/^\//, '').split('/');
    const bucket = segments.shift() ?? '';
    const key = segments.join('/');
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      stats.bytesIn += body.length;
      dispatch({
        req,
        res,
        bucket,
        key,
        query: url.searchParams,
        body,
        target: path.join(root, bucket, key),
        root,
        stats,
        rejectConditionalWrites,
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    stats,
    reset() {
      stats.requests.length = 0;
      stats.bytesOut = 0;
      stats.bytesIn = 0;
      stats.refused.length = 0;
    },
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
