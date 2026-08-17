import { test, expect } from '@playwright/test';

// HTTP-level checks for the CloudFront behaviors: the SPA fallback runs on the
// website behavior only, so an API error keeps its status and JSON body while a
// console deep link still gets the shell. See
// docs/architectural-decisions/2026-08-cloudfront-spa-fallback.md.

test('API errors are not replaced with the SPA shell', async ({ request }) => {
  const response = await request.get('/api/definitely-not-a-route');
  const body = await response.text();

  expect({
    status: response.status(),
    isHtmlShell: body.includes('<title>Fil One</title>'),
  }).toEqual({
    status: 404,
    isHtmlShell: false,
  });
});

// The second path is a bucket name S3 accepts but the console's own create form
// does not, and its dots must not make CloudFront treat it as a static object.
// Both requests carry a browser's `Accept`, because the fallback only fires for
// clients that announce they want HTML.
for (const path of ['/buckets', '/buckets/my.bucket.com']) {
  test(`deep link ${path} serves the SPA HTML shell`, async ({ request }) => {
    const response = await request.get(path, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    const body = await response.text();

    expect({
      status: response.status(),
      containsTitle: body.includes('<title>Fil One</title>'),
    }).toEqual({
      status: 200,
      containsTitle: true,
    });
  });
}

test('static files are served instead of the SPA shell', async ({ request }) => {
  const response = await request.get('/favicon.ico');
  const body = await response.text();

  expect({
    status: response.status(),
    isHtmlShell: body.includes('<title>Fil One</title>'),
  }).toEqual({
    status: 200,
    isHtmlShell: false,
  });
});
