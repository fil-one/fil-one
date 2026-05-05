# ADR: Service Orchestrator Management API

**Status:** Accepted
**Date:** 2026-04-29

## Context

FilOne currently integrates with a single Service Orchestrator — Aurora — and the backend is wired directly to Aurora's two-API split (Backoffice + Portal) with Aurora-specific request/response shapes, permission strings, and onboarding semantics. To onboard additional Service Orchestrators in the future without rewriting the backend, we need a stable, vendor-neutral API contract that any Service Orchestrator can implement.

The contract must cover the same capabilities the FilOne backend exercises against Aurora today:

- Tenant lifecycle (create, set up, query, status changes).
- Issuance of credentials FilOne uses to call the Service Orchestrator on behalf of a tenant.
- S3 access-key CRUD scoped to a tenant.
- Usage metering for billing, dashboards, and trial enforcement.

Bucket creation, listing, deletion and all object operations are not in scope for this API: the Service Orchestrator exposes them through the standard S3 API and FilOne drives them over S3 directly (typically via pre-signed URLs).

## Decision

Define a generic **Service Orchestrator Management API** specified in `docs/service-orchestrator-integration/management-openapi.yaml`. Each new Service Orchestrator implements this contract; FilOne's backend talks to Service Orchestrators exclusively through it.

### Authentication

Bearer tokens via the standard `Authorization: Bearer <token>` header.

Two scopes:

- **Partner key** — global, partner-scoped admin credential. Used for tenant lifecycle, status changes, per-tenant API-key issuance, and metrics queries.
- **Tenant key** — tenant-scoped credential issued by the Service Orchestrator, used for S3 access-key CRUD. The Service Orchestrator must reject any request whose path `tenantId` does not match the tenant the key was issued for.

### Tenant lifecycle

- `POST /tenants` performs create & setup synchronously and returns only after the tenant is fully operational. The Service Orchestrator generates and returns a tenant `id`. FilOne passes its organisation ID as `externalId` (the idempotency key): re-calling with the same `externalId` returns the existing tenant. FilOne stores the SO-assigned `id` and uses it as the `{tenantId}` path parameter in all subsequent calls.
- `GET /tenants/{tenantId}` returns operational state: status, resource counts, and resource limits.
- `POST /tenants/{tenantId}/status` sets `active` / `write-locked` / `disabled`; setting the same status twice is a no-op.
- `DELETE /tenants/{tenantId}` permanently deletes the tenant and all resources owned by it (buckets, objects, S3 access keys, per-tenant API keys). The tenant must be in the `disabled` state — the call returns 409 otherwise. The two-phase pattern (disable, then delete) forces the caller to consciously cut off all access before committing to a destructive, irreversible operation. The endpoint is synchronous (matching `POST /tenants`) and idempotent: a call against an already-deleted tenant returns 204.

### Per-tenant API keys

`POST /tenants/{tenantId}/api-keys` issues a tenant-scoped bearer token. The secret is returned only on creation. FilOne stores it in its own secret store and uses it for all subsequent tenant-scoped management calls.

`DELETE /tenants/{tenantId}/api-keys/{keyId}` revokes a specific key by its identifier. Idempotent (204 if already revoked). Multiple API keys may be active for a tenant at the same time, which is the property rotation depends on: issue a new key, switch callers over, then revoke the old one. The Service Orchestrator may impose a per-tenant cap on concurrently-active keys.

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

Service Orchestrators must support at least `1h`, `24h`, and `720h` windows.

### Idempotency

Every operation is safely retryable end-to-end:

- `POST /tenants` returns the existing tenant on duplicate `externalId`.
- `POST /tenants/{id}/status` is a no-op when already in the requested status.
- `DELETE /tenants/{id}` returns 204 if the tenant is already gone.
- `DELETE /tenants/{id}/api-keys/{keyId}` returns 204 if the API key is already revoked.
- `POST .../access-keys` returns 409 on duplicate name; the caller can recover via list + get.
- `DELETE .../access-keys/{id}` returns 204 if already gone.

## Alternatives Considered

### Authentication scoping

Four points on the auth-scoping axis were considered:

| | URL surface | Credentials |
|---|---|---|
| Two-API split (Aurora) | two base URLs (Backoffice + Portal) | one credential each |
| Single API, two scopes (chosen) | one base URL, `{tenantId}` in path | partner key + per-tenant key |
| Single API, single global key | one base URL, `{tenantId}` in path | partner key only |
| Flat URLs + tenant header (Stripe Connect) | one base URL, tenant in header | partner key only |

**Two-API split** was rejected because separate base URLs impose Aurora's specific architecture on every future Service Orchestrator. The same authorization split can be expressed with a single base URL and two security schemes, which is simpler to document, simpler to implement, and avoids leaking one vendor's internals into the contract.

**Single global key** was rejected because per-tenant keys give a concrete, if narrow, defence-in-depth property: a FilOne backend bug that passes the wrong `tenantId` to `/tenants/{tenantId}/access-keys/*` is rejected by the Service Orchestrator rather than silently issuing access keys against the wrong tenant. The protection is narrow — other tenant-scoped endpoints (`status`, `metrics`, info) still trust the partner key — but `access-keys` is the most sensitive endpoint group because the keys it issues grant direct access to tenant data. The blast-radius argument against a global key is otherwise weak (all FilOne secrets share an SSM tree and similar IAM permissions), and the complexity cost of two scopes is bounded: one extra issuance endpoint and one extra cached SSM read per access-key call.

**Flat URLs + tenant header** (Stripe Connect's pattern — a single platform key plus a `Stripe-Account`-style context header) was rejected for the same defence-in-depth reason as the single global key: a header is as easy to mis-set in a backend bug as a URL parameter. Keeping `tenantId` in the path is also more explicit, plays better with per-tenant rate limiting and audit logging, and reads more clearly in OpenAPI-generated documentation.

The chosen partner-key + tenant-key split mirrors GitHub Apps, which require a JWT signed with the app's private key for app-level endpoints (mint installation tokens, list installations) and a separate installation access token for installation-scoped endpoints, with the API enforcing the mismatch.

### Async tenant setup with a separate readiness endpoint

`POST /tenants` would return immediately with `setupStatus: "in_progress"`, and the caller would poll either `GET /tenants/{id}` or a dedicated `GET /tenants/{id}/setup-status` until ready. This matches Aurora's actual behaviour. Rejected because it pushes complexity onto every Service Orchestrator integrator (state machine, polling, retry semantics) and onto the FilOne backend (orchestration, status persistence). A synchronous create+setup is the simplest contract that meets the requirement, and Service Orchestrators whose internal setup is asynchronous can still hold the HTTP request open or short-poll internally before responding.

### Drop `GET /tenants/{id}` entirely

Once `setupStatus` was removed, the tenant-info endpoint became technically optional: the FilOne backend caches status locally and could derive bucket/key counts by listing. Rejected because resource limits (`bucketLimit`, `accessKeyLimit`) are Service Orchestrator-defined and have no other source, and a thin tenant-info read is a natural part of any tenant management API. Dropping it would either move limits onto an unrelated endpoint or hardcode them into the FilOne backend, both of which are worse.

### Bucket management endpoints in the management API

Mirror Aurora's Portal API and expose `createBucket` / `listBuckets` / `getBucketInfo` / `deleteBucket` over the management contract. Rejected because the standard S3 API already covers all of this, and requiring an Service Orchestrator to implement bucket CRUD in two places (S3 Gateway and management API) is duplicative.

### Custom `X-Api-Key` header for authentication

Match Aurora's existing convention. Rejected in favour of standard `Authorization: Bearer <token>`, which is more idiomatic, has first-class support in HTTP clients and OpenAPI tooling, and does not require Service Orchestrators to invent a custom header.

### Client-supplied `tenantId`

FilOne passes its organisation ID as the canonical `tenantId` in `POST /tenants`, and the Service Orchestrator uses it as its primary key. Rejected because it imposes FilOne's ID format and character-set constraints on the Service Orchestrator's database schema. It also risks silent collisions when two different Service Orchestrator partners (e.g. FilOne and another integrator) use organisation IDs that happen to match — per-partner scoping in the Service Orchestrator prevents this only if the Service Orchestrator is already aware of the problem. Allowing the Service Orchestrator to generate its own ID (with FilOne's org ID carried as `externalId`) keeps the primary key under the Service Orchestrator's control and makes the scoping explicit.

### Bare AWS action names without the `s3:` prefix

Aurora expresses permissions as bare AWS action names — `GetObject`, `PutObjectRetention`, `DeleteObjectVersion`. Rejected in favour of including the `s3:` prefix because both AWS IAM and MinIO write S3 actions in the prefixed form (`"Action": "s3:GetObject"`); using the same form on the wire keeps the strings copy-paste compatible with those policy documents. The prefix also disambiguates the namespace if the contract ever needs a non-S3 action.

## Consequences

- New Service Orchestrators can be onboarded by implementing a single OpenAPI contract; the FilOne backend integration becomes generic rather than vendor-specific.
- Bucket and object operations move entirely to the standard S3 API. Existing Aurora Portal calls for bucket management (`create-bucket`, `list-buckets`, `get-bucket`, `get-bucket-analytics` ownership check) will be reworked to use S3.
- The contract requires Service Orchestrators to support synchronous `POST /tenants` (potentially long-running) and to honour idempotency on every mutating endpoint. Service Orchestrators whose native setup flow is fully asynchronous must adapt internally.
- The access-key permission enum gains bucket-management permissions (`s3:CreateBucket`, `s3:ListAllMyBuckets`, `s3:DeleteBucket`) that Aurora's permission strings did not surface as first-class options. Service Orchestrators map these to whatever native primitives they expose.
- FilOne must persist the Service Orchestrator–assigned tenant `id` (returned by `POST /tenants`) alongside its own organisation ID and use it as the `{tenantId}` path parameter in all subsequent management API calls.
- Per-tenant API keys remain part of the integration cost: each tenant has a credential that FilOne stores in SSM and looks up on every tenant-scoped call. The defence-in-depth benefit is preserved.
- Telemetry (TTFB, error rates, RPS) and S3 Gateway observability are explicitly out of scope for this contract; they are delivered through the partner's observability stack.
