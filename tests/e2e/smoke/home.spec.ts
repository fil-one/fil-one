import { test, expect } from '@playwright/test';

// HTTP-level check: confirms CloudFront/S3 is serving the SPA shell at the
// root URL. We intentionally do NOT use `page.goto('/')` here because the
// client-side router immediately redirects anonymous visitors through to
// Auth0, which is covered by auth.spec.ts.
test('root URL serves the SPA HTML shell', async ({ request }) => {
  const response = await request.get('/');
  const body = await response.text();

  expect({
    status: response.status(),
    containsTitle: body.includes('<title>Fil One</title>'),
  }).toEqual({
    status: 200,
    containsTitle: true,
  });
});
