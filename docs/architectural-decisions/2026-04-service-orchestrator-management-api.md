# ADR: Service Orchestrator Management API

**Status:** Accepted
**Date:** 2026-04-29

## Context

FilOne currently integrates with a single Service Orchestrator — Aurora — and the backend is wired directly to Aurora's two-API split (Backoffice + Portal) with Aurora-specific request/response shapes, permission strings, and onboarding semantics. To onboard additional Service Orchestrators in the future without rewriting the backend, we need a stable, vendor-neutral API contract that any Service Orchestrator can implement.

The contract must cover the same capabilities the FilOne backend exercises against Aurora today:

- Tenant lifecycle (create, set up, query, status changes).
- S3 access-key management (create, list, get, and delete) scoped to a tenant.
- Usage metering for billing, dashboards, and trial enforcement.

Bucket creation, listing, deletion and all object operations are not in scope for this API: the Service Orchestrator exposes them through the standard S3 API and FilOne drives them over S3 directly (typically via pre-signed URLs).

## Decision

Define a generic **Service Orchestrator Management API** specified in `docs/service-orchestrator-integration/management-openapi.yaml`. Each new Service Orchestrator implements this contract; FilOne's backend talks to Service Orchestrators exclusively through it.

### Authentication

A single **partner key** authenticates every endpoint. It is a global, partner-scoped admin credential, sent as a bearer token in the standard `Authorization: Bearer <token>` header. The Service Orchestrator must scope this credential so it cannot reach tenants belonging to other partners.

### Tenant lifecycle

- `PUT /tenants/{tenantId}` performs create & setup synchronously and returns only after the tenant is fully operational. The call is idempotent on the client-supplied `tenantId` in the URL path: re-calling with the same identifier returns the existing tenant. The `tenantId` must be a UUID. UUID lets every Service Orchestrator persist the value efficiently and rules out cross-partner collisions by construction. FilOne's organisation IDs are already UUIDs, so FilOne uses its organisation ID verbatim as the `tenantId` without minting or persisting a separate identifier. PUT is the natural verb: the client supplies the identifier and the operation is idempotent by definition.
- `GET /tenants/{tenantId}` returns operational state: status, resource counts, and resource limits.
- `POST /tenants/{tenantId}/status` sets `active` / `write-locked` / `disabled`; setting the same status twice is a no-op.
- `DELETE /tenants/{tenantId}` permanently deletes the tenant and all resources owned by it (buckets, objects, S3 access keys). The tenant must be in the `disabled` state — the call returns 409 otherwise. The two-phase pattern (disable, then delete) forces the caller to consciously cut off all access before committing to a destructive, irreversible operation. The endpoint is synchronous (matching `PUT /tenants/{tenantId}`) and idempotent: a call against an already-deleted tenant returns 204.

### S3 access keys

- `POST /tenants/{tenantId}/access-keys` provisions an AWS Sig V4 access-key pair scoped to the supplied permissions. Optional `buckets` list restricts the key to specific buckets; optional `expiresAt` sets a hard expiry. The `secretAccessKey` is returned only in this response. Returns 409 on duplicate `name`.
- `GET /tenants/{tenantId}/access-keys` lists all access keys for the tenant (secrets omitted).
- `GET /tenants/{tenantId}/access-keys/{accessKeyId}` returns metadata for a single key; the secret is never returned.
- `DELETE /tenants/{tenantId}/access-keys/{accessKeyId}` revokes the key immediately; returns 204 even if the key was already deleted.

Permissions use AWS S3 IAM action names verbatim (e.g. `s3:GetObject`, `s3:CreateBucket`, `s3:PutObjectRetention`) rather than custom abstractions. We preserve AWS quirks like `s3:ListBucket` permission for listing _objects_ in a bucket and `s3:ListAllMyBuckets` permission to list buckets.

### Usage metering

Two time-series endpoints, both parameterised by `from` / `to` / `window`, each returning storage, egress, and ingress samples in a single response:

- `GET /tenants/{tenantId}/metrics` — tenant-level storage (bytes used + object count), egress (bytes downloaded), and ingress (bytes uploaded).
- `GET /tenants/{tenantId}/buckets/{bucketName}/metrics` — per-bucket equivalent; the Service Orchestrator must verify that the bucket belongs to the path `tenantId`.

Service Orchestrators must support at least:

- A query range (`to` − `from`) of 62 days (covers a 31-day billing period plus a 30-day grace period, with a one-day buffer).
- Window values of `1h`, `24h`, and `720h`.
- 1488 data points per response (62 days at 1 h granularity — the highest-resolution, longest-range query FilOne issues).

### Idempotency

Every operation is safely retryable end-to-end:

- `PUT /tenants/{tenantId}` returns the existing tenant on duplicate `tenantId`.
- `POST /tenants/{tenantId}/status` is a no-op when already in the requested status.
- `DELETE /tenants/{tenantId}` returns 204 if the tenant is already gone.
- `POST /tenants/{tenantId}/access-keys` returns 409 on duplicate name; the caller can recover via list + get.
- `DELETE /tenants/{tenantId}/access-keys/{accessKeyId}` returns 204 if already gone.

## Alternatives Considered

### Authentication scoping

Four points on the auth-scoping axis were considered:

|                                            | URL surface                         | Credentials                  |
| ------------------------------------------ | ----------------------------------- | ---------------------------- |
| Two-API split (Aurora)                     | two base URLs (Backoffice + Portal) | one credential each          |
| Single API, single partner key (chosen)    | one base URL, `{tenantId}` in path  | partner key only             |
| Single API, two scopes                     | one base URL, `{tenantId}` in path  | partner key + per-tenant key |
| Flat URLs + tenant header (Stripe Connect) | one base URL, tenant in header      | partner key only             |

**Two-API split** was rejected because separate base URLs impose Aurora's specific architecture on every future Service Orchestrator. The same surface can be expressed with a single base URL, which is simpler to document, simpler to implement, and avoids leaking one vendor's internals into the contract.

**Two scopes (partner key + per-tenant key)** was rejected because the defence-in-depth benefit is too narrow to justify the integration cost. The argument for a tenant-scoped key was that a FilOne backend bug that passes the wrong `tenantId` in the URL would be rejected by the Service Orchestrator rather than silently acting on another tenant's resources. In practice the protection only covers access-key CRUD: the other tenant-scoped endpoints (`status`, `metrics`, tenant info, deletion) already use the partner key, and the Service Orchestrator must enforce per-partner tenant scoping on the partner key in any case (otherwise tenants belonging to other partners would be reachable). Once that scoping is in place, FilOne's own `tenantId` mismatches are caught uniformly across every endpoint, not just access keys. Adding a second credential adds a key-issuance endpoint to the contract, key-rotation semantics every Service Orchestrator must implement, and one extra secret per tenant for FilOne to store and rotate — disproportionate cost for a partial mitigation that is better addressed by the Service Orchestrator's existing partner-scoping check and by FilOne's own tenant-isolation tests.

**Flat URLs + tenant header** (Stripe Connect's pattern — a single platform key plus a `Stripe-Account`-style context header) was rejected because keeping `tenantId` in the path is more explicit, plays better with per-tenant rate limiting and audit logging on the Service Orchestrator side, and reads more clearly in OpenAPI-generated documentation. The credential count is the same either way.

### Async tenant setup with a separate readiness endpoint

`PUT /tenants/{tenantId}` would return immediately with `setupStatus: "in_progress"`, and the caller would poll either `GET /tenants/{tenantId}` or a dedicated `GET /tenants/{tenantId}/setup-status` until ready. This matches Aurora's actual behaviour. Rejected because it pushes complexity onto every Service Orchestrator integrator (state machine, polling, retry semantics) and onto the FilOne backend (orchestration, status persistence). A synchronous create+setup is the simplest contract that meets the requirement, and Service Orchestrators whose internal setup is asynchronous can still hold the HTTP request open or short-poll internally before responding.

### Drop `GET /tenants/{id}` entirely

Once `setupStatus` was removed, the tenant-info endpoint became technically optional: the FilOne backend caches status locally and could derive bucket/key counts by listing. Rejected because resource limits (`bucketLimit`, `accessKeyLimit`) are Service Orchestrator-defined and have no other source, and a thin tenant-info read is a natural part of any tenant management API. Dropping it would either move limits onto an unrelated endpoint or hardcode them into the FilOne backend, both of which are worse.

### Bucket management endpoints in the management API

Mirror Aurora's Portal API and expose `createBucket` / `listBuckets` / `getBucketInfo` / `deleteBucket` over the management contract. Rejected because the standard S3 API already covers all of this, and requiring a Service Orchestrator to implement bucket CRUD in two places (S3 Gateway and management API) is duplicative.

### Path-versioned URLs (e.g. `/v1/tenants/…`)

Prefix all routes with a version segment so that a future breaking revision can live at `/v2/…` alongside the existing `/v1/…` routes. Rejected for now: there is no concrete need for a second version, and adding the prefix prematurely locks the version into every integration before the contract has stabilised. If breaking changes are needed in the future, both paths remain open: a `/v2/` prefix can be introduced alongside the existing unversioned (implicitly v1) routes, or HTTP content negotiation (`Accept`/`Content-Type` version parameters) can be used without touching the URL surface at all.

### Custom `X-Api-Key` header for authentication

Match Aurora's existing convention. Rejected in favour of standard `Authorization: Bearer <token>`, which is more idiomatic, has first-class support in HTTP clients and OpenAPI tooling, and does not require Service Orchestrators to invent a custom header.

### Server-assigned tenant IDs

Server returns a tenant `id`; the client carries its own identifier separately (e.g. Aurora's `name` slug, or an opaque `externalId` used as the idempotency key). Rejected because it forces FilOne to store and look up a Service Orchestrator-assigned identifier alongside its organisation ID, and to keep the two in sync on every call. The motivations that would otherwise favour SO-assignment — letting the Service Orchestrator control its primary-key format, and avoiding cross-partner ID collisions — are both addressed by requiring the client-supplied `tenantId` to be a UUID: UUID is a universally accepted identifier format that any Service Orchestrator can persist directly, and UUID randomness rules out cross-partner collisions by construction.

### Bare AWS action names without the `s3:` prefix

Aurora expresses permissions as bare AWS action names — `GetObject`, `PutObjectRetention`, `DeleteObjectVersion`. Rejected in favour of including the `s3:` prefix because both AWS IAM and MinIO write S3 actions in the prefixed form (`"Action": "s3:GetObject"`); using the same form on the wire keeps the strings copy-paste compatible with those policy documents. The prefix also disambiguates the namespace if the contract ever needs a non-S3 action.

## Consequences

- New Service Orchestrators can be onboarded by implementing a single OpenAPI contract; the FilOne backend integration becomes generic rather than vendor-specific.
- Bucket and object operations move entirely to the standard S3 API. Existing Aurora Portal calls for bucket management (`create-bucket`, `list-buckets`, `get-bucket`, `get-bucket-analytics` ownership check) will be reworked to use S3.
- The contract requires Service Orchestrators to support synchronous `PUT /tenants/{tenantId}` (potentially long-running) and to honour idempotency on every mutating endpoint. Service Orchestrators whose native setup flow is fully asynchronous must adapt internally.
- The access-key permission enum gains bucket-management permissions (`s3:CreateBucket`, `s3:ListAllMyBuckets`, `s3:DeleteBucket`) that Aurora's permission strings did not surface as first-class options. Service Orchestrators map these to whatever native primitives they expose.
- A single partner key authenticates every endpoint, including tenant-scoped operations. The Service Orchestrator must enforce per-partner tenant scoping so the partner key cannot reach tenants belonging to other partners.
- Telemetry (TTFB, error rates, RPS) and S3 Gateway observability are explicitly out of scope for this contract; they are delivered through the partner's observability stack.
- Aurora's current metrics endpoints cap a single request at a ~40-day `to` − `from` span, which is below the 62-day contract minimum. To remain unblocked while Aurora catches up, the FilOne backend's Aurora client splits longer requests into ≤ 40-day sub-ranges, issues them in parallel, and dedupes samples by timestamp at the boundary. Service Orchestrators that meet the 62-day requirement on a single request need no workaround.
