import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SPA_REWRITE_FUNCTION_CODE } from './spa-rewrite.js';

interface CloudFrontRequest {
  method: string;
  uri: string;
  querystring?: Record<string, { value: string }>;
  headers: Record<string, { value: string }>;
}

type Handler = (event: { request: CloudFrontRequest }) => CloudFrontRequest;

const handler = runInNewContext(`${SPA_REWRITE_FUNCTION_CODE}; handler`) as Handler;
const sstConfig = readFileSync(new URL('../../../sst.config.ts', import.meta.url), 'utf8');

function request(
  uri: string,
  {
    method = 'GET',
    accept = 'text/html,application/xhtml+xml',
    destination = 'document',
    mode = 'navigate',
    querystring,
  }: {
    method?: string;
    accept?: string | null;
    destination?: string | null;
    mode?: string | null;
    querystring?: Record<string, { value: string }>;
  } = {},
): CloudFrontRequest {
  const headers: Record<string, { value: string }> = {};
  if (accept !== null) headers.accept = { value: accept };
  if (destination !== null) headers['sec-fetch-dest'] = { value: destination };
  if (mode !== null) headers['sec-fetch-mode'] = { value: mode };
  return { method, uri, headers, querystring };
}

describe('SPA CloudFront rewrite', () => {
  it('stays within the CloudFront Function source-size limit', () => {
    expect(Buffer.byteLength(SPA_REWRITE_FUNCTION_CODE, 'utf8')).toBeLessThanOrEqual(10 * 1024);
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
    ['API root', '/api'],
    ['API path', '/api/access-keys'],
    ['API missing resource', '/api/buckets/missing'],
    ['login', '/login'],
    ['login subpath', '/login/callback'],
    ['logout', '/logout'],
    ['logout subpath', '/logout/callback'],
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

  it('does not rewrite an API-ish request with a query string', () => {
    const original = request('/api/unknown', {
      querystring: { format: { value: 'html' } },
    });
    const result = handler({ request: original });
    expect(result.uri).toBe('/api/unknown');
    expect(result.querystring).toEqual({ format: { value: 'html' } });
  });

  it.each(['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'])(
    'does not rewrite %s requests',
    (method) => {
      expect(handler({ request: request('/dashboard', { method }) }).uri).toBe('/dashboard');
    },
  );

  it.each([
    ['missing Accept', null],
    ['generic Accept', '*/*'],
    ['JSON Accept', 'application/json'],
    ['JavaScript Accept', 'text/javascript,*/*;q=0.1'],
  ])('does not rewrite navigation-shaped paths with %s', (_name, accept) => {
    expect(handler({ request: request('/dashboard', { accept }) }).uri).toBe('/dashboard');
  });

  it.each(['empty', 'script', 'style', 'image', 'font'])(
    'does not rewrite sec-fetch-dest=%s',
    (destination) => {
      expect(handler({ request: request('/extensionless-resource', { destination }) }).uri).toBe(
        '/extensionless-resource',
      );
    },
  );

  it.each(['cors', 'no-cors', 'same-origin', 'websocket'])(
    'does not rewrite sec-fetch-mode=%s',
    (mode) => {
      expect(handler({ request: request('/extensionless-resource', { mode }) }).uri).toBe(
        '/extensionless-resource',
      );
    },
  );

  it('supports older clients that send HTML Accept without Fetch Metadata', () => {
    const result = handler({
      request: request('/dashboard', { destination: null, mode: null }),
    });
    expect(result.uri).toBe('/index.html');
  });

  it('matches media types and Fetch Metadata case-insensitively', () => {
    const result = handler({
      request: request('/dashboard', {
        accept: 'TEXT/HTML',
        destination: 'DOCUMENT',
        mode: 'NAVIGATE',
      }),
    });
    expect(result.uri).toBe('/index.html');
  });

  it.each([
    ['positive quality', 'text/html;q=0.5'],
    ['maximum quality', 'text/html;q=1.000'],
    ['mixed media ranges', 'application/json;q=1, text/html;q=0.7'],
    ['whitespace, case, and parameters', ' TEXT/HTML ; charset=UTF-8 ; Q = 0.750 '],
    ['unrelated token parameter', 'text/html;charset=utf-8'],
    ['multiple token parameters', 'text/html;profile=console-v1;level=1;q=0.5'],
  ])('rewrites HTML navigation with %s', (_name, accept) => {
    expect(handler({ request: request('/dashboard', { accept }) }).uri).toBe('/index.html');
  });

  it.each([
    ['zero quality', 'text/html;q=0'],
    ['zero decimal quality', 'text/html;q=0.000'],
    ['zero quality among mixed ranges', 'application/json, text/html;q=0, image/png'],
    ['explicit rejection plus wildcard', 'text/html;q=0, */*;q=1'],
    ['missing quality value', 'text/html;q='],
    ['non-numeric quality', 'text/html;q=bogus'],
    ['out-of-range quality', 'text/html;q=1.1'],
    ['missing leading zero', 'text/html;q=.5'],
    ['too many fractional digits', 'text/html;q=0.0001'],
    ['quoted quality', 'text/html;q="0.5"'],
    ['duplicate quality', 'text/html;q=0.5;q=0.4'],
    ['parameter without a value', 'text/html;broken'],
    ['empty parameter', 'text/html;'],
    ['parameter without a name', 'text/html;=oops'],
    ['empty parameter value', 'text/html;charset='],
    ['deliberately unsupported quoted parameter', 'text/html;charset="utf-8"'],
  ])('does not rewrite HTML navigation with %s', (_name, accept) => {
    expect(handler({ request: request('/dashboard', { accept }) }).uri).toBe('/dashboard');
  });
});

describe('SST CloudFront wiring', () => {
  it('does not configure distribution-wide custom error responses', () => {
    expect(sstConfig).not.toContain('customErrorResponses');
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
