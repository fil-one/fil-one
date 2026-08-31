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

The function rewrites the URI to `/index.html` for a `GET` whose path sits outside the `/assets`,
`/static`, and `/.well-known` namespaces and whose `Sec-Fetch-Dest`, when the client sends one,
is `document`. Everything else passes through. Only `request.uri` changes, so the query string
survives, and the rewrite happens before the cache key is computed, so a navigation and an XHR to
the same path cannot share a cache entry.

**Fetch Metadata is the only classifier.** An earlier draft also parsed `Accept` for a `text/html`
range with a non-zero quality value. That meant a q-value grammar, a token grammar for media-type
parameters, and about forty test cases at the edge, all to approximate a question `Sec-Fetch-Dest`
answers directly. Browsers have sent Fetch Metadata since Chrome 80, Firefox 90, and Safari 16.4,
and a request that declares `script`, `style`, `image`, `font`, `iframe`, or `empty` is not a
navigation whatever it puts in `Accept`. A client that sends no Fetch Metadata at all — a crawler,
a link unfurler, `curl`, the Playwright request context — gets the shell, which is what makes a
deep link shareable.

**The ordered behaviors do the API and auth exclusion.** The function carries no `/api`, `/login`,
or `/logout` guard. `/api/*` is an ordered behavior on the API origin and covers every route in
the manifest, including `/api/auth/callback`; `/login` and `/logout` are exact-match ordered
behaviors and are the only auth paths the manifest serves. Those requests never reach the website
origin, so a guard here would be a second copy of a rule CloudFront already enforces, and a copy
that drifts. The leftovers — a bare `/api`, or a `/login/...` subpath no route claims — fall to
the default behavior and become console routes, where the client router answers.

`args.defaultRootObject = 'index.html'` overlaps with the function, which maps `/` to
`/index.html` as well. Both are kept: `defaultRootObject` is what still serves the root if the
function association is ever removed.

A suffixed path is treated as a concrete object only at the top level, because every object in the
bucket is either `/index.html`, one of the three files in `packages/website/public`, or under
`/assets`. Deeper paths stay client routes even when a segment carries a dot: S3 accepts bucket
names such as `my.bucket.com`, which the console links to at `/buckets/my.bucket.com`.

## Where the code lives

`packages/cloudfront-functions/src/spa-rewrite.js` is the deployed source, written in the
CloudFront JavaScript 2.0 dialect: no imports or exports, `var` declarations, and a top-level
`function handler(event)`. It is a `.js` file in its own package rather than a string constant in
`@filone/shared` so that an editor, the formatter, and the linter all read it as the code it is.
`sst.config.ts` reads the file at synth time and passes its contents as the function body;
`packages/cloudfront-functions/src/spa-rewrite.test.ts` reads the same file and evaluates it in a
`node:vm` context, so the tests exercise the bytes that ship rather than a second model of them.
One of those tests walks `packages/website/public` (and `packages/website/dist` after a build) and
asserts every object in the bucket passes through the classifier untouched.

The path is resolved against the working directory, matching the `distPath` lookup below it, not
against `import.meta.url`: SST bundles `sst.config.ts` into `.sst/platform/` before running it, so
a module-relative URL would resolve inside the build directory.

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
- `HEAD` is not rewritten, so a link checker that HEADs a console deep link gets S3's 403 rather
  than a 200 with no body. Browsers navigate with `GET`.
- Static files in a subdirectory of `packages/website/public` would be served to `img`, `script`,
  and `style` requests but return the console shell when typed into the address bar. The
  cloudfront-functions test walks `public/` and `dist/` and asserts every object path passes
  through as a document, so adding such a file fails the build rather than shipping the ambiguity.
  Root-level files and `/assets` are unambiguous today.
- The transform assigns the default behavior's `functionAssociations` outright. Anything that makes
  SST populate that field for the `/*` route, such as a route-level `rewrite`, needs to be
  reconciled with this association.
