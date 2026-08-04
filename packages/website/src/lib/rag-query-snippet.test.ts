import { describe, it, expect, beforeEach, vi } from 'vitest';

// API_URL is read at call time, so a getter lets each test pick the deployment
// shape it cares about: a configured API host, or prod's empty value.
const envMock = { API_URL: '' };

vi.mock('../env.js', () => ({
  get API_URL() {
    return envMock.API_URL;
  },
}));

import { buildQueryCurl } from './rag-query-snippet.js';

describe('buildQueryCurl', () => {
  beforeEach(() => {
    envMock.API_URL = '';
  });

  it('targets the query endpoint with the bucket name and region', () => {
    envMock.API_URL = 'https://api.example.com';
    const curl = buildQueryCurl({ bucketName: 'my-docs', region: 'us-east-1' });
    expect(curl).toContain(
      'curl -X POST "https://api.example.com/api/buckets/my-docs/query?region=us-east-1"',
    );
  });

  it("falls back to the page's own origin when API_URL is empty, as it is in prod", () => {
    // Same-origin behind CloudFront, so the sample still needs an absolute URL.
    const curl = buildQueryCurl({ bucketName: 'my-docs', region: 'us-east-1' });
    expect(curl).toContain(
      `"${window.location.origin}/api/buckets/my-docs/query?region=us-east-1"`,
    );
  });

  it('authorizes with an env var rather than a literal token', () => {
    // A literal key here would end up in the reader's shell history.
    const curl = buildQueryCurl({ bucketName: 'my-docs', region: 'us-east-1' });
    expect(curl).toContain('-H "Authorization: Bearer $FILONE_RAG_KEY"');
    expect(curl).toContain('-H "Content-Type: application/json"');
  });

  it('sends a valid JSON body carrying the documented query fields', () => {
    const curl = buildQueryCurl({ bucketName: 'my-docs', region: 'us-east-1' });
    const body = curl.match(/-d '(.*)'$/)?.[1];
    expect(body).toBeDefined();
    expect(JSON.parse(body as string)).toEqual({
      query: expect.any(String),
      top_k: expect.any(Number),
    });
  });

  it('keeps the JSON body free of single quotes, which would end the shell string early', () => {
    const body = buildQueryCurl({ bucketName: 'my-docs', region: 'us-east-1' }).match(
      /-d '(.*)'$/,
    )?.[1];
    expect(body).not.toContain("'");
  });

  it('emits a line-continued command, so it stays runnable when pasted whole', () => {
    const lines = buildQueryCurl({ bucketName: 'my-docs', region: 'us-east-1' }).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.slice(0, 3).every((l) => l.endsWith(' \\'))).toBe(true);
    expect(lines[3]).not.toMatch(/\\$/);
  });

  it('passes placeholders through verbatim, so the API tab can show the endpoint shape', () => {
    const curl = buildQueryCurl({ bucketName: '{bucketName}', region: '{region}' });
    expect(curl).toContain('/api/buckets/{bucketName}/query?region={region}');
  });
});
