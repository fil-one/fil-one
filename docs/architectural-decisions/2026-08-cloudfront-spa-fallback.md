# ADR: Scope the SPA fallback to the website cache behavior

**Status:** Accepted
**Date:** 2026-08-17

## Context

One CloudFront distribution serves both the console bucket and the API. The SPA deep-link
fallback was expressed as distribution-wide custom error responses that mapped 403 and 404 to
`/index.html` with a 200. That configuration is a property of the distribution, not of a cache
behavior, and CloudFront has no per-behavior equivalent. It therefore rewrote API responses too:
a grace-period write returned its 403 status with the console's HTML document as the body, and the
console reported `Unexpected token '<', "<!doctype "... is not valid JSON` (FIL-261, FIL-400).

The 403 entry existed for a second reason. The bucket is private behind an origin access control
without `s3:ListBucket`, so S3 masks a missing key as `AccessDenied` and CloudFront sees 403 rather
than 404. The API's honest 403 was caught by a rule that only existed to paper over that.

## Decision

In response to Miroslav's FIL-400 options analysis, implement Option 3 only in this change. Option 1
remains a follow-up because the smallest policy change SST exposes would not scope the new
permission to this distribution, as explained below.

Delete the distribution-wide error mapping and attach a CloudFront Function to the default cache
behavior as a viewer-request trigger. `'/*': { bucket }` is the default behavior and `/api/*`,
`/login`, and `/logout` are ordered behaviors, so CloudFront's behavior matcher does the
discrimination and API responses reach the browser untouched by construction.

The function rewrites the URI to `/index.html` only for a `GET` whose path sits outside the API,
auth, `/assets`, `/static`, and `/.well-known` namespaces, whose `Accept` header lists `text/html`
with a quality above zero, and whose Fetch Metadata, when present, says `document` plus `navigate`.
Everything else passes through, including requests that supply a malformed HTML media range. Only
`request.uri` changes, so the query string survives, and the rewrite happens before the cache key is
computed, so a navigation and an XHR to the same path cannot share a cache entry.

A suffixed path is treated as a concrete object only at the top level, because every object in the
bucket is either `/index.html`, one of the three files in `packages/website/public`, or under
`/assets`. Deeper paths stay client routes even when a segment carries a dot: S3 accepts bucket
names such as `my.bucket.com`, which the console links to at `/buckets/my.bucket.com`.

The deployed source lives in `packages/shared/src/spa-rewrite.ts` as a single string constant
because CloudFront Functions cannot import modules. `packages/shared/src/spa-rewrite.test.ts`
evaluates that exact string in a VM, so the tests exercise the code that ships rather than a second
model of it.

## Alternatives considered

**Grant `s3:ListBucket` for CloudFront.** Miroslav's Option 1 is useful on its own: missing keys
would return real 404s instead of S3's masked 403s. It is not part of this change. In the installed
SST version, `Bucket`'s small `policy` path can grant `s3:ListBucket` to the
`cloudfront.amazonaws.com` service principal, but it cannot bind that statement to the specific
distribution that uses the router's origin access control. The existing `access: 'cloudfront'`
statement has the same unscoped service principal shape for `s3:GetObject`, and the router creates
the distribution and OAC separately. A least-privilege grant therefore needs the bucket policy and
router/distribution ownership restructured so an `AWS:SourceArn` condition can reference the
resulting distribution. That change must be synthesized and its effective access verified with AWS
credentials, which are unavailable in this local environment. It also would not replace Option 3:
a distribution-wide 404 fallback would still turn API 404 bodies into HTML 200 responses.

**Serve the bucket through the S3 website endpoint and its error document.** Website endpoints do
not support origin access control, so the bucket would have to be publicly readable or gated by an
origin secret, and the CloudFront-to-S3 leg would drop to HTTP. Deep links would also return 404
instead of 200.

**Materialize every route as a static object at build time.** Dynamic segments such as
`/buckets/:name` cannot be enumerated, so this covers only part of the route table.

**Split the console and the API onto separate hostnames.** This reverses the same-origin decision
in `2026-03-sign-in-redirect.md` and expands the CORS, cookie, CSP, DNS, and certificate surface.
It is the right answer when the API justifies its own distribution, not a fix for this bug.

**Use the Router's route-level `edge.viewerRequest` injection instead of a raw function.** SST
attaches that function to the same behavior, so the scoping would be equivalent, but the classifier
would live as a string literal inside `sst.config.ts` with no way to test it. It would also collide
with the `cdn` transform, which assigns the default behavior's `functionAssociations` outright.

## Operational notes

- CloudFront Functions run sub-millisecond with no cold start and bill at $0.10 per million
  invocations after 2M free per month. The source limit is 10 KB; a test asserts it.
- A missing object under `/assets` or at the top level now surfaces S3's `AccessDenied` 403 instead
  of the previous HTML 200. A follow-up can add a distribution-scoped `s3:ListBucket` grant and
  turn those responses into 404s after AWS-authenticated policy verification.
- A client that does not announce HTML, such as `curl` with its default `Accept: */*`, now receives
  S3's 403 for a console route instead of the shell. Browsers, crawlers, and link unfurlers send an
  explicit `text/html` range, and `tests/e2e/smoke/routing.spec.ts` sets one for the same reason.
- Static files kept in a subdirectory of `packages/website/public` are still served to `img`,
  `script`, and `style` requests, but typing one into the address bar returns the console shell.
  Root-level files and `/assets` do not have that ambiguity.
- The transform assigns the default behavior's `functionAssociations` outright. Anything that makes
  SST populate that field for the `/*` route, such as a route-level `rewrite`, needs to be
  reconciled with this association.
