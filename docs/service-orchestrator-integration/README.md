# Service Orchestrator Integration Requirements

This document describes what FilOne needs from a Service Orchestrator to integrate it as a new FilOne region.

## Overview

FilOne integrates with a Service Orchestrator through two HTTP surfaces:

- a **Management API** for tenant lifecycle, S3 access-key management, and usage metering; and
- an **S3 Gateway**, used directly by FilOne's backend and the FilOne Console UI to drive bucket and object operations.

The Management API contract is defined in [`management-openapi.yaml`](./management-openapi.yaml). The S3 Gateway is a standard S3-compatible endpoint; the requirements below describe what FilOne needs from it.

```
+-------------------------------------------------------+
|  Service Orchestrator APIs                            |
|                                                       |
|  +--------------------------------------------------+ |
|  | Management API                                   | |
|  | (partner API key)                                | |
|  |                                                  | |
|  | - Create / get / delete tenant                   | |
|  | - Set tenant status                              | |
|  | - Create / list / get / delete S3 access keys    | |
|  | - Query usage metrics (per-tenant & per-bucket)  | |
|  +--------------------------------------------------+ |
|                                                       |
|  +--------------------------------------------------+ |
|  | S3 Gateway                                       | |
|  | (per-tenant access key + secret, AWS Sig V4)     | |
|  |                                                  | |
|  | - PutObject / GetObject (pre-signed URLs)        | |
|  | - ListObjectsV2, HeadObject, DeleteObject        | |
|  | - CreateBucket, ListBuckets, DeleteBucket        | |
|  +--------------------------------------------------+ |
|                                                       |
+-------------------------------------------------------+
```

## API Conventions

These conventions apply to both the Management API and the S3 Gateway unless stated otherwise.

### Authentication

The Management API uses a single **partner key**, sent as a bearer token in the standard `Authorization: Bearer <token>` header. The key is a global, partner-scoped admin credential — not tenant-specific. The Service Orchestrator must scope it so that it cannot reach tenants belonging to other partners.

The S3 Gateway uses per-tenant AWS Sig V4 access keys, provisioned through the Management API.

### Transport

All API traffic — Management API and S3 Gateway alike — must be served over HTTPS/TLS.

### Versioning

The Management API is unversioned at this stage. Future breaking revisions will be introduced via a `/v2` URL prefix or HTTP content negotiation; partners do not need to plan for versioning today.

## Management API

### Tenant Lifecycle

FilOne provisions one tenant per customer organisation on demand — typically when the user creates their first bucket in a region managed by a given Service Orchestrator. Provisioning is synchronous: FilOne calls `PUT /tenants/{tenantId}` and waits for the tenant to be fully operational before proceeding.

The Service Orchestrator must expose an API to create a tenant given a client-supplied `tenantId` (a UUID, in the URL path) and a human-readable display name. The `tenantId` is the canonical identifier in every subsequent call and the idempotency key for `PUT /tenants/{tenantId}` — a retry with the same `tenantId` must return the existing tenant. UUID is the contract's only format constraint, picked so any Service Orchestrator can persist the value efficiently and so cross-partner collisions are ruled out by construction. FilOne uses its organisation ID (already a UUID) verbatim.

The Service Orchestrator must also expose a tenant info endpoint (`GET /tenants/{tenantId}`) that returns the tenant's current status, resource counts (buckets, access keys), and resource limits (`bucketLimit`, `accessKeyLimit`). These limits are Service Orchestrator–defined: the Service Orchestrator is the only source of truth for what a given tenant is allowed to hold, and FilOne's dashboard reads them directly from this endpoint.

The Service Orchestrator must support three tenant states — `active`, `write-locked`, and `disabled` — and expose an API endpoint to transition between them. Enforcement happens in the S3 Gateway; see [Tenant State Enforcement](#tenant-state-enforcement) for the semantics of each state.

The Service Orchestrator must also expose a tenant deletion endpoint that permanently removes the tenant and all owned resources (buckets, objects, access keys). Deletion requires the tenant to be in the `disabled` state first, so the caller has to consciously cut off all access before committing to the destructive operation. The endpoint is synchronous and irreversible: if cleanup of one or more owned resources fails partway through, the Service Orchestrator must return a 5xx and the tenant must remain deletable on retry — there must be no half-deleted, undeletable state.

The entire tenant lifecycle — from creation through credential provisioning to full readiness — must be API-driven with no manual steps (no portal clicks, email verification, or human-in-the-loop approvals).

### S3 Access Keys

End-users manage their own S3 access keys through the FilOne console. The Service Orchestrator must support creating, listing, retrieving, and deleting access keys through the management API. When a user creates an access key, FilOne sends the key name, a set of permissions, an optional list of buckets (for scoped access), and an optional expiration date.

In addition to user-created keys, FilOne creates one system S3 access key per tenant during onboarding. This key is used by the FilOne Console UI to perform bucket and object operations on the user's behalf (create/list/delete buckets, upload/download/list/delete objects, etc.). The system key is created via the same `POST /tenants/{tenantId}/access-keys` endpoint and is transparent to the Service Orchestrator: from the Service Orchestrator's perspective, a tenant has `1 + X` access keys at any moment — one created by FilOne and `X` created by the end user. The Service Orchestrator does not need to treat the system key specially.

FilOne uses AWS S3 IAM action names as permission scopes. The Service Orchestrator maps each value to its native permission model when creating the key. Permission strings include the `s3:` prefix (e.g. `s3:GetObject`, not bare `GetObject`) so they are copy-paste compatible with AWS IAM and MinIO policy documents (`"Action": "s3:GetObject"`).

Bucket-level scopes:

- `s3:CreateBucket`, `s3:ListAllMyBuckets`, `s3:DeleteBucket`.

Object-level scopes — the basic actions (`s3:GetObject`, `s3:PutObject`, `s3:ListBucket`, `s3:DeleteObject`) cover the common case, with variant actions for operations on versions, retention policies, and legal holds:

- `s3:GetObject`, `s3:GetObjectVersion`, `s3:GetObjectRetention`, `s3:GetObjectLegalHold`
- `s3:PutObject`, `s3:PutObjectRetention`, `s3:PutObjectLegalHold`
- `s3:ListBucket`, `s3:ListBucketVersions`
- `s3:DeleteObject`, `s3:DeleteObjectVersion`

Note the AWS quirk that `s3:ListBucket` lists _objects_ in a bucket, while `s3:ListAllMyBuckets` lists buckets. Similarly, `s3:ListBucketVersions` allows listing _object_ versions in a bucket.

Deleting an access key should revoke the key immediately so that subsequent S3 requests using those credentials fail.

### Usage Metrics

FilOne relies on the Service Orchestrator for all usage data. The Service Orchestrator must expose two time-series metrics endpoints, each returning storage, egress, and ingress data together for a specified time range:

- `GET /tenants/{tenantId}/metrics` — tenant-level usage.
- `GET /tenants/{tenantId}/buckets/{bucketName}/metrics` — per-bucket usage. The Service Orchestrator must verify that the bucket belongs to the path `tenantId` and return 404 otherwise.

For storage, FilOne queries hourly samples of bytes used and object count. The dashboard also queries storage metrics with a wider window (30 days, single sample) for a quick current-usage snapshot.

For egress (outbound data transfer), FilOne queries egress consumption in bytes aggregated in 24-hour windows.

For ingress (inbound data transfer), FilOne queries ingress consumption in bytes alongside the storage and egress data — all three metric types share the same `from` / `to` / `window` parameters and are returned in a single response.

The endpoints must support a full 31-day billing period at hourly resolution. See the `from`, `to`, and `window` query parameters in [`management-openapi.yaml`](./management-openapi.yaml) for the canonical minimum range, supported windows, and per-response sample capacity.

Reliability of these endpoints is important.

### Idempotency

Several Management API operations must be safely retried: tenant creation (return existing on conflict), tenant deletion (succeed if already deleted), access key creation (return conflict error so FilOne can recover), access key deletion (succeed if already deleted), and tenant status updates (setting the same status twice is a no-op). Every step of the onboarding and every background job must handle duplicate invocations without side effects.

## S3 Gateway

The S3 Gateway is a standard S3-compatible endpoint reached at `https://{region}.s3.fil.one`. FilOne's backend and the FilOne Console UI drive bucket and object operations directly against this gateway, often via pre-signed URLs. Authentication uses per-tenant AWS Sig V4 access keys issued through the Management API.

### Required Features

- Bucket operations (create/list/delete)
- Object operations (put/get/head/list)
- Server-side encryption of object payloads; must be enabled by default
- Pre-signed URLs
- CORS configuration allowing (pre-signed) requests from app.fil.one and staging.fil.one
- Multi-part uploads
- Path-style addressing
- AWS Signature V4 authentication
- Metadata headers (x-amz-meta-\*)
- Versioning, Object Lock and Retention
- DNS-level forwarding (`https://{region}.s3.fil.one`)

### Bucket Creation and Deletion

Bucket creation accepts a name and several optional settings: versioning enabled, Object Lock enabled, and a default retention policy (mode – either GOVERNANCE or COMPLIANCE – plus a duration with its unit). Buckets are always created with server-side encryption enabled. The Service Orchestrator should return a clear error (HTTP 409 or equivalent) if a bucket with the same name already exists within the tenant, so that FilOne can show a user-friendly message.

Deleting a bucket should fail if the bucket still contains objects.

### Tenant State Enforcement

The S3 Gateway must enforce the tenant state set via the Management API:

- `active` — read/write access.
- `write-locked` — read-only; uploads and bucket creation blocked, but reads, listings, and deletes succeed.
- `disabled` — all access blocked. Data is persisted and recoverable by transitioning back to `active`.

### Telemetry

The Service Orchestrator must export the following S3 Gateway metrics through the partner's observability stack (not through the APIs):

- S3 GetObject Time-to-First-Byte
- S3 4xx Responses (count per second or per minute)
- S3 5xx Responses (count per second or per minute)
- S3 Total Requests (count per second or per minute)
- S3 Egress (bytes per second or per minute)
- S3 Ingress (bytes per second or per minute)

## Tenant Isolation

Each tenant's data must be invisible and inaccessible to other tenants, even if they share the same underlying infrastructure. S3 credentials for one tenant must not grant access to another tenant's buckets or objects. The Management API must enforce partner scoping so that one partner's key cannot operate on tenants of a different partner.
