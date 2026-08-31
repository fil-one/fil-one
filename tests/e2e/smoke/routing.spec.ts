import { test, expect } from '@playwright/test';

// HTTP-level checks for the CloudFront behaviors: the SPA fallback runs on the
// website behavior only, so an API error keeps its status and JSON body while a
// console deep link still gets the shell. See
// docs/architectural-decisions/2026-08-cloudfront-spa-fallback.md.

function isHtmlShell(body: string): boolean {
  return body.includes('<title>Fil One</title>');
}

test('API errors are not replaced with the SPA shell', async ({ request }) => {
  const response = await request.get('/api/definitely-not-a-route');
  const body = await response.text();

  expect({
    status: response.status(),
    isHtmlShell: isHtmlShell(body),
  }).toEqual({
    status: 404,
    isHtmlShell: false,
  });
});

// The second path is a bucket name S3 accepts but the console's own create form
// does not, and its dots must not make CloudFront treat it as a static object.
// Neither request sets Accept: the classifier reads Sec-Fetch-Dest, which the
// Playwright request context does not send, and a client without Fetch Metadata
// is exactly the crawler or link unfurler a deep link has to work for.
for (const path of ['/buckets', '/buckets/my.bucket.com']) {
  test(`deep link ${path} serves the SPA HTML shell`, async ({ request }) => {
    const response = await request.get(path);
    const body = await response.text();

    expect({
      status: response.status(),
      isHtmlShell: isHtmlShell(body),
    }).toEqual({
      status: 200,
      isHtmlShell: true,
    });
  });
}

// The rewrite is scoped to GET. A HEAD reaches S3 as written, so a deep link
// answers from the bucket — where the key does not exist — rather than being
// turned into a successful HTML document.
test('HEAD on a deep link is not rewritten to the SPA shell', async ({ request }) => {
  const response = await request.head('/buckets/my.bucket.com');

  expect(response.ok()).toBe(false);
});

test('static files are served instead of the SPA shell', async ({ request }) => {
  const response = await request.get('/favicon.ico');
  const body = await response.text();

  expect({
    status: response.status(),
    isHtmlShell: isHtmlShell(body),
  }).toEqual({
    status: 200,
    isHtmlShell: false,
  });
});
