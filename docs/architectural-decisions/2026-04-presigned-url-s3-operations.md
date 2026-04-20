# ADR: Presigned URL Architecture for S3 Operations

**Status:** Accepted
**Date:** 2026-04-10

## Context

The Hyperspace console proxies all S3 operations through individual Lambda handlers. Each handler fetches Aurora S3 credentials from AWS SSM Parameter Store, executes the S3 operation against the Aurora S3-compatible endpoint, and returns the result to the frontend via API Gateway. These Lambdas run at 1024 MB with provisioned concurrency in production, making them expensive for what is essentially a pass-through.

Upload (`presign-upload.ts`) and download (`download-object.ts`) already use presigned URLs — the Lambda generates a time-limited signed URL and the browser talks to Aurora S3 directly. The remaining operations (ListObjects, HeadObject, GetObjectRetention, DeleteObject) still proxy through Lambda, adding latency and cost for no security benefit.

The current architecture also couples every S3 operation to Aurora-specific Lambda handlers. As the platform prepares to support arbitrary S3-compatible storage providers, the per-operation Lambda pattern becomes harder to maintain — each new provider would multiply the handler count.

### Current Request Path (Proxied)

```
Browser -> CloudFront -> API Gateway -> Lambda -> Aurora S3 -> Lambda -> API Gateway -> CloudFront -> Browser
```

### Desired Request Path (Presigned)

```
Browser -> Lambda (presign, ~50ms) -> Browser -> Aurora S3 (direct)
```

### Latency Implications

Moving S3 operations from Lambda-proxied to browser-direct changes the network routing. For users geographically close to the Lambda region (us-east-2), the presigned path is faster because it eliminates the proxy hop. For users far from the Aurora S3 region (eu-west-1), the direct browser-to-Aurora path can be slower than the Lambda-to-Aurora path because the Lambda is closer to Aurora than the browser is.

Example latencies (based on https://latency.bluegoat.net/):

For our primary target market — users in Europe (eu-central-1, Germany) — the presigned path is faster:

| Path                   | Hops                                                                            | Total  |
| ---------------------- | ------------------------------------------------------------------------------- | ------ |
| **Current (proxied)**  | eu-central-1 → us-east-2 (~102ms) + us-east-2 → eu-west-2 (~79ms)               | ~181ms |
| **Presigned (direct)** | eu-central-1 → us-east-2 (~102ms presign) + eu-central-1 → eu-west-2 (~20ms S3) | ~122ms |

That's a ~60ms (~30%) improvement for European customers on every S3 operation.

For users in geographies far from both regions (e.g., New Zealand, ap-southeast-6), the presigned path can be slower because the browser hop to eu-west-1 is longer than the Lambda hop:

| Path                   | Hops                                                                                 | Total  |
| ---------------------- | ------------------------------------------------------------------------------------ | ------ |
| **Current (proxied)**  | ap-southeast-6 → us-east-2 (~212ms) + us-east-2 → eu-west-1 (~90ms)                  | ~302ms |
| **Presigned (direct)** | ap-southeast-6 → us-east-2 (~212ms presign) + ap-southeast-6 → eu-west-1 (~296ms S3) | ~508ms |

This is an acceptable trade-off because: our primary target geography benefits, the presign call is a lightweight JSON request (~50ms Lambda execution), most latency-sensitive operations (list, head) return small payloads, and the consolidated Lambda at 512 MB with lower provisioned concurrency reduces ongoing infrastructure cost. For large file uploads/downloads, the direct path avoids the API Gateway payload size limit and data transfer overhead, which is a net improvement regardless of routing.

## Options Considered

### Browser S3 Client with Temporary Credentials

A single Lambda vends short-lived S3 credentials (`accessKeyId`, `secretAccessKey`, `sessionToken`). The frontend creates an `S3Client` (from `@aws-sdk/client-s3`) in the browser and makes S3 calls directly. One credential fetch covers many operations. The AWS SDK handles XML parsing, error mapping, and pagination natively.

Aurora does not support STS-style session credentials. Its access keys support an `expiresAt` field, but with day-level granularity (YYYY-MM-DD format). These are real persistent keys stored in Aurora's key management system — creating one per browser session would clutter the access key list, require cleanup, and still expose long-lived credentials. Aurora's Token API (`POST /auth/v1/tenants/{tenantId}/tokens`) produces Portal API bearer tokens, not S3 Signature V4 credentials.

Without true short-lived credentials, this approach sends the tenant's long-lived S3 access key and secret key to the browser. Even over HTTPS, the blast radius is unacceptable: a leaked credential (XSS, browser extension, memory dump) grants full S3 access until the key is manually rotated. This option becomes viable if Aurora adds STS support in the future.

### Batch Presigned URL Endpoint

A single `POST /api/presign` Lambda accepts an array of S3 operation descriptors and returns presigned URLs for each. The frontend executes the presigned URLs directly against Aurora S3 and parses the responses. Credentials never leave the backend.

Each presigned URL is scoped to exactly one operation, one bucket/key, and expires in 5 minutes. A leaked URL grants access to a single read or delete — not the entire tenant's S3 namespace. Batching (up to 10 operations per request) reduces round-trips for pages that need multiple S3 calls (e.g., object detail batches HeadObject and, when the bucket has Object Lock enabled, GetObjectRetention in a single presign request).

The main cost is that the frontend must parse S3 XML responses (ListObjects, GetObjectRetention) and HTTP headers (HeadObject). This is handled by a small frontend utility using the browser-native `DOMParser`.

## Decision

Use **batch presigned URLs** via a single `POST /api/presign` endpoint.

### Operations Moved to Presigned URLs

| Operation            | HTTP Method | Notes                                                 |
| -------------------- | ----------- | ----------------------------------------------------- |
| ListObjectsV2        | GET         | Frontend parses S3 XML response                       |
| HeadObject           | HEAD        | `fil-include-meta=1` signed into URL for Filecoin CID |
| GetObjectRetention   | GET         | Frontend parses retention XML                         |
| GetObject (download) | GET         | Consolidates existing `download-object.ts`            |
| PutObject (upload)   | PUT         | Consolidates existing `presign-upload.ts`             |
| DeleteObject         | DELETE      | Presigned URL is the authorization; no CSRF needed    |

### Operations Remaining on Lambda

| Operation    | Reason                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ListBuckets  | Aurora Portal REST API (API key auth, not S3 Sig V4)                                                                                                              |
| GetBucket    | Aurora Portal REST API (returns rich metadata including `objectLockEnabled`, used by the frontend to conditionally include GetObjectRetention in presign batches) |
| CreateBucket | Aurora Portal API mutation                                                                                                                                        |
| DeleteBucket | Aurora Portal API; must verify bucket is empty server-side                                                                                                        |

ListBuckets could switch from the Portal API to the S3 `ListBuckets` command (making it presignable), since the handler currently only uses `name`, `createdAt`, `region` (hardcoded), and `isPublic` (hardcoded false). However, the Portal API returns richer metadata that will matter as the UI matures. This can be revisited independently.

### Presign Endpoint Design

**Route:** `POST /api/presign`

**Middleware:** Auth (JWT cookie) + subscription guard. No CSRF — presigned URLs are themselves the authorization token.

**Write vs Read access:** The subscription guard middleware runs at the Read access level so that listing and viewing objects continues to work during a grace period or past-due state. The handler then inspects the batch to determine if any operations require Write access (`putObject`, `deleteObject`). If so, and the account is in a grace period or past due, the handler returns a 403 before generating any presigned URLs. This ensures users retain read-only access to their data while preventing mutations until the subscription is reactivated. Although the presigned URL API itself only performs reads (signing URLs, not executing S3 operations), enforcing the write/read distinction at presign time prevents vending URLs that could be used for unauthorized writes — a defense-in-depth measure that also supports future access control changes (e.g., user roles).

**Request:** Array of 1–10 operation descriptors, each a discriminated union on the `op` field (`listObjects`, `headObject`, `getObjectRetention`, `getObject`, `putObject`, `deleteObject`).

**Response:** Array of `{ url, method, expiresAt }` items in the same order as the request, plus the S3 `endpoint` (supports multi-provider routing in the future).

**URL expiry:** 300 seconds, matching the existing `PRESIGN_EXPIRY_SECONDS`.

### HeadObject with Aurora Filecoin Metadata

The current `headObject` handler injects `fil-include-meta=1` as a query parameter via S3 middleware and captures the `x-fil-cid` response header. For presigned URLs, the `fil-include-meta=1` parameter is included in the signing process by attaching the same middleware to the S3Client before calling `getSignedUrl`. The presigner runs the middleware stack, so the parameter becomes part of the signed URL. The frontend reads `x-fil-cid` from the response headers (requires Aurora CORS to expose it via `Access-Control-Expose-Headers`).

### Multi-Provider Architecture

The presign endpoint is designed to support arbitrary S3-compatible providers:

- The `endpoint` field in the response tells the frontend where to execute the URL
- The backend resolves provider and credentials per bucket (today all Aurora, tomorrow per-provider lookup)
- Presigned URLs are provider-agnostic from the frontend's perspective — an HTTP URL with a method
- The frontend S3 response parsers work with any S3-compatible XML format

### Frontend S3 Response Parsing

A new `aurora-s3.ts` module provides browser-native parsers:

- `parseListObjectsResponse` — `DOMParser` on `<ListBucketResult>` XML
- `parseHeadObjectResponse` — reads HTTP response headers
- `parseGetObjectRetentionResponse` — parses `<Retention>` XML
- `parseS3ErrorResponse` — parses S3 error XML (expired URL, not found, access denied)

### Lambda Consolidation

Five handlers are replaced by one:

| Removed              | Memory  | Provisioned |
| -------------------- | ------- | ----------- |
| `list-objects.ts`    | 1024 MB | Yes         |
| `head-object.ts`     | 1024 MB | Yes         |
| `download-object.ts` | default | Yes         |
| `presign-upload.ts`  | default | Yes         |
| `delete-object.ts`   | default | No          |

| Added        | Memory | Provisioned |
| ------------ | ------ | ----------- |
| `presign.ts` | 512 MB | Yes         |

## Risks

### Aurora CORS Header Exposure

The Aurora S3 endpoint must expose `x-fil-cid` and `x-amz-meta-*` headers via `Access-Control-Expose-Headers` for HeadObject to work from the browser. Without this, the Filecoin CID and custom metadata are invisible to JavaScript. Aurora's CORS configuration has been verified to support GET, HEAD, PUT, and DELETE methods with the required exposed headers (`x-fil-cid`, `x-amz-meta-*`, `ETag`, `Content-Length`, `Content-Type`, `Last-Modified`). Both the presign handler and the frontend changes can ship together.

### Multi-Provider Header Support

The browser-direct path makes response headers part of the provider contract. Any future S3-compatible provider must expose `x-amz-meta-*` (standard) via CORS for custom metadata to reach the UI, and — for Filecoin-specific features — also `x-fil-cid` (non-standard, Aurora-specific today). `x-fil-cid` is not part of the S3 spec, so supporting Filecoin features on a non-Aurora provider will either require the provider to adopt the same custom header or require a provider-specific path to resolve the CID. This constraint is tracked alongside the broader provider contract requirements.

### S3 XML Parsing in the Browser

The frontend takes on responsibility for parsing S3 XML responses. Edge cases (empty buckets, special characters in keys, truncated responses, error XML) must be tested. Mitigated by using the browser-native `DOMParser` and writing unit tests for each parser.

### Presigned URL Expiry During Slow Pages

If a user idles on a page and React Query refetches after the presigned URL has expired, the S3 call will return 403. Mitigated by React Query's stale-while-revalidate pattern: the presign + execute is a single `queryFn`, so refetches generate fresh URLs.

## Consequences

- S3 read and delete operations bypass Lambda entirely after the presign call. Latency improves by eliminating the proxy hop (~100–300ms for large payloads).
- Five Lambda handlers are consolidated into one lightweight handler at 512 MB instead of 1024 MB. Provisioned concurrency cost drops proportionally.
- API Gateway data transfer costs decrease — S3 response payloads no longer flow through API Gateway.
- The frontend owns S3 response parsing, adding ~200 lines of parser code that must be maintained.
- CSRF protection is no longer needed for DeleteObject — the presigned URL itself is the authorization token, scoped to one key and expiring in 5 minutes.
- The presign endpoint's `endpoint` response field and provider-agnostic URL execution position the frontend to support multiple S3-compatible providers without structural changes.
- If Aurora adds STS support in the future, the architecture can evolve to vend temporary credentials instead of presigned URLs, eliminating the per-operation presign overhead while keeping the same frontend execution model.
