// Deployed as a CloudFront Function on the website distribution's default cache
// behavior (viewer request). The CloudFront JavaScript 2.0 runtime is not
// Node: there are no modules, so this file has no import or export, declares
// with `var`, and exposes a top-level `handler`. sst.config.ts reads it
// verbatim at synth time and src/spa-rewrite.test.ts evaluates this same file,
// so the tested code is the deployed code.
//
// Division of labour with CloudFront's ordered cache behaviors: `/api/*`,
// `/login`, and `/logout` are ordered behaviors on the API origin, so those
// requests never reach this function and need no guard here. Everything else
// falls to the `/*` default behavior on the website bucket, which is what this
// function classifies. `/` is handled twice over: the distribution's
// defaultRootObject already maps it to /index.html before the function runs,
// and the rewrite below would produce the same URI.

function handler(event) {
  var request = event.request;
  var uri = request.uri || '/';

  // A navigation is a GET. Never turn a POST, HEAD, or OPTIONS into a
  // successful HTML document.
  if (request.method !== 'GET') {
    return request;
  }

  // Asset namespaces hold real objects, including extensionless ones, and
  // /.well-known holds protocol endpoints. None of them are client routes.
  if (
    uri === '/assets' ||
    uri.indexOf('/assets/') === 0 ||
    uri === '/static' ||
    uri.indexOf('/static/') === 0 ||
    uri === '/.well-known' ||
    uri.indexOf('/.well-known/') === 0
  ) {
    return request;
  }

  // Every object in the website bucket sits either at the bucket root or under
  // the asset namespaces excluded above, so a suffixed top-level path is a
  // concrete object and S3 should answer for it. A dot deeper in the path
  // belongs to a route parameter: S3 accepts bucket names such as
  // my.bucket.com, and /buckets/my.bucket.com has to stay a console deep link.
  var segments = uri.split('/');
  if (segments.length === 2 && segments[1].indexOf('.') !== -1) {
    return request;
  }

  // Fetch Metadata is the whole classifier. A browser sets Sec-Fetch-Dest on
  // every request, so `document` means a top-level navigation and anything else
  // is a subresource or an XHR. Clients that send no Fetch Metadata at all —
  // crawlers, link unfurlers, curl, the Playwright request context — still get
  // the shell, which is what makes a deep link shareable.
  var headers = request.headers || {};
  var destination = headers['sec-fetch-dest'] ? headers['sec-fetch-dest'].value : '';
  if (destination && destination.toLowerCase() !== 'document') {
    return request;
  }

  // Only the URI changes, so the query string survives, and this runs before
  // the cache key is computed, so a navigation and an XHR to the same path
  // cannot share a cache entry.
  request.uri = '/index.html';
  return request;
}
