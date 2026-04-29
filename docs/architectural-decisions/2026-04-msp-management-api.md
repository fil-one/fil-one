# ADR: MSP Management API

**Status:** Accepted
**Date:** 2026-04-29

## Context

FilOne currently integrates with a single managed service provider (MSP) — Aurora — and the backend is wired directly to Aurora's two-API split (Backoffice + Portal) with Aurora-specific request/response shapes, permission strings, and onboarding semantics. To onboard additional MSPs in the future without rewriting the backend, we need a stable, vendor-neutral API contract that any MSP can implement.

The contract must cover the same capabilities the FilOne backend exercises against Aurora today:

- Tenant lifecycle (create, set up, query, status changes).
- Issuance of credentials FilOne uses to call the MSP on behalf of a tenant.
- S3 access-key CRUD scoped to a tenant.
- Usage metering for billing, dashboards, and trial enforcement.

Bucket creation, listing, deletion and all object operations are not in scope for this API: the MSP exposes them through the standard S3 API and FilOne drives them over S3 directly (typically via pre-signed URLs).

## Decision

Define a generic **MSP Management API** specified in `docs/msp-integration/management-openapi.yaml`. Each new MSP implements this contract; FilOne's backend talks to MSPs exclusively through it.

### Authentication

Bearer tokens via the standard `Authorization: Bearer <token>` header. No custom headers.

Two scopes:

- **Partner key** — global, partner-scoped admin credential. Used for tenant lifecycle, status changes, per-tenant API-key issuance, and metrics queries.
- **Tenant key** — tenant-scoped credential issued by the MSP, used for S3 access-key CRUD. The MSP must reject any request whose path `tenantId` does not match the tenant the key was issued for.

### Tenant lifecycle

A single endpoint, `POST /tenants`, performs **create + setup synchronously** and returns only after the tenant is fully operational. The call is idempotent on a client-supplied `tenantId` (FilOne's organisation ID): re-calling with the same identifier returns the existing tenant. There is no `setupStatus` field anywhere in the API and no polling endpoint — readiness is implied by the `2xx` response.

`GET /tenants/{tenantId}` returns operational state: status, resource counts, and resource limits. `POST /tenants/{tenantId}/status` sets `active` / `write-locked` / `disabled`; setting the same status twice is a no-op.

`DELETE /tenants/{tenantId}` permanently deletes the tenant and all resources owned by it (buckets, objects, S3 access keys, per-tenant API keys). The tenant must be in the `disabled` state — the call returns 409 otherwise. The two-phase pattern (disable, then delete) forces the caller to consciously cut off all access before committing to a destructive, irreversible operation. The endpoint is synchronous (matching `POST /tenants`) and idempotent: a call against an already-deleted tenant returns 204.

### Per-tenant API keys

`POST /tenants/{tenantId}/api-keys` issues a tenant-scoped bearer token. The secret is returned only on creation. FilOne stores it in its own secret store and uses it for all subsequent tenant-scoped management calls.

### S3 access keys

CRUD under `/tenants/{tenantId}/access-keys`, authenticated by a tenant key. Permissions use AWS S3 IAM action names verbatim (e.g. `s3:GetObject`, `s3:CreateBucket`, `s3:PutObjectRetention`) rather than custom abstractions. The full set covers:

- Bucket-level: `s3:CreateBucket`, `s3:ListAllMyBuckets`, `s3:DeleteBucket`.
- Object-level basic: `s3:GetObject`, `s3:PutObject`, `s3:ListBucket`, `s3:DeleteObject`.
- Object-level variants for versions, retention, and legal hold: `s3:GetObjectVersion`, `s3:GetObjectRetention`, `s3:GetObjectLegalHold`, `s3:PutObjectRetention`, `s3:PutObjectLegalHold`, `s3:ListBucketVersions`, `s3:DeleteObjectVersion`.

Optional `buckets` list scopes the key; optional `expiresAt` enforces a hard deadline. Duplicate `name` returns 409. `DELETE` returns 204 even if the key was already deleted.

### Usage metering

Three time-series endpoints under the partner key, all parameterised by `from` / `to` / `window`:

- `GET /tenants/{tenantId}/metrics/storage` — tenant storage (bytes used + object count).
- `GET /tenants/{tenantId}/metrics/egress` — tenant egress (bytes downloaded).
- `GET /tenants/{tenantId}/buckets/{bucketName}/metrics/storage` — per-bucket storage.

MSPs must support at least `1h`, `24h`, and `720h` windows.

### Idempotency

Every operation is safely retryable end-to-end:

- `POST /tenants` returns the existing tenant on duplicate `tenantId`.
- `POST /tenants/{id}/status` is a no-op when already in the requested status.
- `DELETE /tenants/{id}` returns 204 if the tenant is already gone.
- `POST .../access-keys` returns 409 on duplicate name; the caller can recover via list + get.
- `DELETE .../access-keys/{id}` returns 204 if already gone.

## Alternatives Considered

### Re-use Aurora's two-API split (Backoffice + Portal)

Mirror Aurora's separation between a global "backoffice" and a per-tenant "portal" with different base URLs and overlapping resources. Rejected because it imposes Aurora's specific architecture on every future MSP. The same authorization split can be expressed with a single base URL and two security schemes, which is simpler to document, simpler to implement, and avoids leaking one vendor's internals into the contract.

### Async tenant setup with a separate readiness endpoint

`POST /tenants` would return immediately with `setupStatus: "in_progress"`, and the caller would poll either `GET /tenants/{id}` or a dedicated `GET /tenants/{id}/setup-status` until ready. This matches Aurora's actual behaviour. Rejected because it pushes complexity onto every MSP integrator (state machine, polling, retry semantics) and onto the FilOne backend (orchestration, status persistence). A synchronous create+setup is the simplest contract that meets the requirement, and MSPs whose internal setup is asynchronous can still hold the HTTP request open or short-poll internally before responding.

### Drop `GET /tenants/{id}` entirely

Once `setupStatus` was removed, the tenant-info endpoint became technically optional: the FilOne backend caches status locally and could derive bucket/key counts by listing. Rejected because resource limits (`bucketLimit`, `accessKeyLimit`) are MSP-defined and have no other source, and a thin tenant-info read is a natural part of any tenant management API. Dropping it would either move limits onto an unrelated endpoint or hardcode them into the FilOne backend, both of which are worse.

### Single global key for everything (no per-tenant keys)

Use the partner key for every operation, including S3 access-key CRUD. Rejected. The blast-radius argument against the global key is largely theoretical given that all FilOne secrets share an SSM tree and similar IAM permissions, but per-tenant keys provide a concrete defence-in-depth property: a FilOne backend bug that passes the wrong `tenantId` in the URL is rejected by the MSP rather than silently leaking one tenant's resources to another. The complexity cost is bounded — one extra endpoint, one extra SSM read per call (cached) — and the scoping primitive is required if FilOne ever wants to delegate tenant-scoped management access externally.

### Bucket management endpoints in the management API

Mirror Aurora's Portal API and expose `createBucket` / `listBuckets` / `getBucketInfo` / `deleteBucket` over the management contract. Rejected because the standard S3 API already covers all of this, and requiring an MSP to implement bucket CRUD in two places (S3 Gateway and management API) is duplicative. FilOne's existing bucket flows that go through Aurora's Portal will be migrated to S3 as part of integrating the new contract.

### Custom `X-Api-Key` header for authentication

Match Aurora's existing convention. Rejected in favour of standard `Authorization: Bearer <token>`, which is more idiomatic, has first-class support in HTTP clients and OpenAPI tooling, and does not require MSPs to invent a custom header.

### Server-assigned tenant IDs with a separate `name` slug

Aurora's model: server returns a tenant `id`, client supplies a unique `name`. Rejected for the generic API in favour of letting the client supply the canonical `tenantId` directly. FilOne already has a stable per-org identifier; introducing a second ID adds a lookup step on the backend and a state-tracking burden for no real benefit.

### Bare AWS action names without the `s3:` prefix

Aurora expresses permissions as bare AWS action names — `GetObject`, `PutObjectRetention`, `DeleteObjectVersion`. Rejected in favour of including the `s3:` prefix because both AWS IAM and MinIO write S3 actions in the prefixed form (`"Action": "s3:GetObject"`); using the same form on the wire keeps the strings copy-paste compatible with those policy documents. The prefix also disambiguates the namespace if the contract ever needs a non-S3 action.

## Consequences

- New MSPs can be onboarded by implementing a single OpenAPI contract; the FilOne backend integration becomes generic rather than vendor-specific.
- Bucket and object operations move entirely to the standard S3 API. Existing Aurora Portal calls for bucket management (`create-bucket`, `list-buckets`, `get-bucket`, `get-bucket-analytics` ownership check) will be reworked to use S3.
- The contract requires MSPs to support synchronous `POST /tenants` (potentially long-running) and to honour idempotency on every mutating endpoint. MSPs whose native setup flow is fully asynchronous must adapt internally.
- The access-key permission enum gains bucket-management permissions (`bucket:create`, `bucket:list`, `bucket:delete`) that Aurora's permission strings did not surface as first-class options. MSPs map these to whatever native primitives they expose.
- Per-tenant API keys remain part of the integration cost: each tenant has a credential that FilOne stores in SSM and looks up on every tenant-scoped call. The defence-in-depth benefit is preserved.
- Telemetry (TTFB, error rates, RPS) and S3 Gateway observability are explicitly out of scope for this contract; they are delivered through the partner's observability stack.
