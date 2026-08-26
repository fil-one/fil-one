import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface CloudFrontRequest {
  method: string;
  uri: string;
  querystring?: Record<string, { value: string }>;
  headers: Record<string, { value: string }>;
}

type Handler = (event: { request: CloudFrontRequest }) => CloudFrontRequest;

const sourceUrl = new URL('./spa-rewrite.js', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8');
// The CloudFront runtime has no modules, so the file is evaluated as a script
// and `handler` is picked up off the resulting scope. Tests therefore exercise
// the deployed bytes rather than a second model of the routing logic.
const handler = runInNewContext(`${source}; handler`) as Handler;
const sstConfig = readFileSync(new URL('../../../sst.config.ts', import.meta.url), 'utf8');

function request(
  uri: string,
  {
    method = 'GET',
    destination = 'document',
    querystring,
  }: {
    method?: string;
    destination?: string | null;
    querystring?: Record<string, { value: string }>;
  } = {},
): CloudFrontRequest {
  const headers: Record<string, { value: string }> = {};
  if (destination !== null) headers['sec-fetch-dest'] = { value: destination };
  return { method, uri, headers, querystring };
}

function objectPaths(root: URL): string[] {
  const dir = fileURLToPath(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `/${relative(dir, `${entry.parentPath}/${entry.name}`).replaceAll('\\', '/')}`);
}

describe('SPA CloudFront rewrite', () => {
  it('stays within the CloudFront Function source-size limit', () => {
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThanOrEqual(10 * 1024);
  });

  it.each([
    ['root', '/'],
    ['top-level route', '/dashboard'],
    ['nested route', '/buckets/example'],
    ['trailing slash', '/buckets/example/'],
    ['encoded route segment', '/buckets/example%20bucket'],
    ['dot in a parent segment', '/release.v2/guide'],
    ['bucket name containing dots', '/buckets/my.bucket.com'],
    ['object list under a dotted bucket', '/buckets/my.bucket.com/objects'],
  ])('rewrites %s navigation to index.html', (_name, uri) => {
    expect(handler({ request: request(uri) }).uri).toBe('/index.html');
  });

  it('preserves query strings while rewriting a navigation', () => {
    const querystring = {
      tab: { value: 'billing' },
      returnTo: { value: '/buckets/example' },
    };
    const result = handler({ request: request('/settings', { querystring }) });
    expect(result.uri).toBe('/index.html');
    expect(result.querystring).toBe(querystring);
  });

  it.each([
    ['assets root', '/assets'],
    ['extensionless asset', '/assets/runtime'],
    ['extensionless static file', '/static/config'],
    ['well-known root', '/.well-known'],
    ['well-known protocol resource', '/.well-known/openid-configuration'],
    ['missing JavaScript', '/assets/missing.js'],
    ['missing CSS', '/missing.css'],
    ['missing source map', '/app.js.map'],
    ['missing image', '/missing.svg'],
    ['missing manifest', '/manifest.webmanifest'],
    ['missing HTML object', '/missing.html'],
    ['dotfile', '/.env'],
  ])('does not rewrite %s', (_name, uri) => {
    expect(handler({ request: request(uri) }).uri).toBe(uri);
  });

  // CloudFront's ordered behaviors, not this function, keep the API and auth
  // paths off the website origin. `/api/*` matches every API route including
  // /api/auth/callback; `/login` and `/logout` match exactly and are the only
  // auth paths the route manifest serves. What is left over — a bare `/api`,
  // or a `/login/...` subpath that no route claims — reaches the default
  // behavior and becomes a console route, where the client router answers.
  it.each([
    ['bare API root', '/api'],
    ['unclaimed login subpath', '/login/callback'],
    ['unclaimed logout subpath', '/logout/callback'],
  ])('rewrites %s, which no ordered behavior claims', (_name, uri) => {
    expect(handler({ request: request(uri) }).uri).toBe('/index.html');
  });

  it.each(['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'])(
    'does not rewrite %s requests',
    (method) => {
      expect(handler({ request: request('/dashboard', { method }) }).uri).toBe('/dashboard');
    },
  );

  it.each(['empty', 'script', 'style', 'image', 'font', 'iframe'])(
    'does not rewrite sec-fetch-dest=%s',
    (destination) => {
      expect(handler({ request: request('/extensionless-resource', { destination }) }).uri).toBe(
        '/extensionless-resource',
      );
    },
  );

  it('serves the shell to clients that send no Fetch Metadata', () => {
    expect(handler({ request: request('/dashboard', { destination: null }) }).uri).toBe(
      '/index.html',
    );
  });

  it('matches Fetch Metadata case-insensitively', () => {
    expect(handler({ request: request('/dashboard', { destination: 'DOCUMENT' }) }).uri).toBe(
      '/index.html',
    );
  });

  // Anything actually in the bucket has to survive the classifier, whatever a
  // build adds to it. `public/` is copied to the bucket root; `dist/` is the
  // built site and is only present after `pnpm build`.
  const bucketObjects = [
    ...objectPaths(new URL('../../website/public/', import.meta.url)),
    ...objectPaths(new URL('../../website/dist/', import.meta.url)),
  ];

  it('has bucket objects to check', () => {
    expect(bucketObjects.length).toBeGreaterThan(0);
  });

  it.each([...new Set(bucketObjects)])('passes bucket object %s through untouched', (uri) => {
    expect(handler({ request: request(uri) }).uri).toBe(uri);
  });
});

describe('SST CloudFront wiring', () => {
  it('does not configure distribution-wide custom error responses', () => {
    expect(sstConfig).not.toContain('customErrorResponses');
  });

  it('deploys this file as the function source', () => {
    expect(sstConfig).toContain('packages/cloudfront-functions/src/spa-rewrite.js');
    expect(sstConfig).toContain('runtime: ');
    expect(sstConfig).toContain('cloudfront-js-2.0');
    // The classifier no longer travels through @filone/shared.
    expect(sstConfig).not.toContain('SPA_REWRITE_FUNCTION_CODE');
  });

  it('associates the rewrite only with the default website behavior', () => {
    expect(sstConfig).toContain('defaultBehavior.functionAssociations = [');
    expect(sstConfig).toContain("eventType: 'viewer-request'");
    expect(sstConfig).toContain('functionArn: spaRewriteFunction.arn');
    // The transform assigns the default behavior's associations outright, so a
    // second viewer-request function added through the route's
    // `edge.viewerRequest` option would be dropped without warning.
    expect(sstConfig).not.toContain('edge.viewerRequest');
  });

  it('retains ordered API and auth behaviors outside the website default', () => {
    expect(sstConfig).toContain("'/api/*': {");
    expect(sstConfig).toContain("'/login': {");
    expect(sstConfig).toContain("'/logout': {");
  });
});
