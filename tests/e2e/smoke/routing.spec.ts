import { test, expect } from '@playwright/test';

// HTTP-level checks for CloudFront routing: the SPA fallback must be scoped
// to the S3 behavior and never rewrite API origin responses. Regression tests
// for the distribution-wide customErrorResponses bug, where any 403/404 from
// /api/* was rewritten into a 200 index.html and the API's status code and
// JSON error body never reached the browser.

test('API 404s are not masked by the SPA fallback', async ({ request }) => {
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

test('SPA deep link serves the HTML shell', async ({ request }) => {
  const response = await request.get('/buckets');
  const body = await response.text();

  expect({
    status: response.status(),
    containsTitle: body.includes('<title>Fil One</title>'),
  }).toEqual({
    status: 200,
    containsTitle: true,
  });
});

test('static files are served, not rewritten to the shell', async ({ request }) => {
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
