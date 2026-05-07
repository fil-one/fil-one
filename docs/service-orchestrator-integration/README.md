# Service Orchestrator Integration Requirements

This document describes what FilOne needs from a Service Orchestrator to integrate it as a new FilOne region.

## Summary

APIs:

- Tenant management (isolated per-organisation accounts)
- Tenant statuses (active; write-locked; disabled)
- S3 Access Key management
- S3 Gateway
- Usage metrics at tenant and bucket level (storage bytes, object count, egress bytes, ingress bytes)

The Service Orchestrator's S3 Gateway must implement the following features:

- Bucket operations (create/list/delete)
- Object operations (put/get/head/list)
- Server-side encryption of object payloads
- Pre-signed URLs
- CORS configuration allowing (pre-signed) requests from app.fil.one and staging.fil.one
- Multi-part uploads
- Path-style addressing
- AWS Signature V4 authentication
- Metadata headers (x-amz-meta-\*)
- Versioning, Object Lock and Retention
- DNS-level forwarding (https://{region}.s3.fil.one)

Non-functional requirements:

- Tenant isolation
- Idempotency for management API calls
- _(eventually should have)_ metrics for the S3 Gateway (TTFB, response times, 4xx/5xx error rates, etc.)

```
+-----------------------------------------------------------------+
|  Service Orchestrator APIs                                      |
|                                                                 |
|  +------------------------------------------------------------+ |
|  | Management API                                             | |
|  | (partner API key)                                          | |
|  |                                                            | |
|  | - Create / get / delete tenant                             | |
|  | - Set tenant status                                        | |
|  | - Create / list / get / delete S3 access keys              | |
|  | - Query usage metrics (per-tenant & per-bucket)            | |
|  +------------------------------------------------------------+ |
|                                                                 |
|  +------------------------------------------------------------+ |
|  | S3 Gateway                                                 | |
|  | (per-tenant access key + secret, AWS Sig V4)               | |
|  |                                                            | |
|  | - PutObject / GetObject (pre-signed URLs)                  | |
|  | - ListObjectsV2, HeadObject, DeleteObject                  | |
|  | - CreateBucket, ListBuckets, DeleteBucket                  | |
|  | - GetObjectRetention                                       | |
|  +------------------------------------------------------------+ |
|                                                                 |
+-----------------------------------------------------------------+
```

## Tenant Management

FilOne provisions one tenant per customer organisation on demand — typically when the user creates their first bucket in a region managed by a given Service Orchestrator. Provisioning is synchronous: FilOne calls `POST /tenants` and waits for the tenant to be fully operational before proceeding.

The Service Orchestrator must expose an API to create a tenant given FilOne's organisation ID (passed as `externalId`) and a human-readable display name. The Service Orchestrator generates and returns its own tenant ID; FilOne stores the returned ID and uses it as the identifier in all subsequent management API calls. `externalId` values are scoped per partner: two different Service Orchestrator partners may use the same `externalId` without collision, because the Service Orchestrator must scope tenant identifiers to the partner whose key was used for the request. If the creation request is retried with the same `externalId`, the Service Orchestrator must return the existing tenant rather than failing.

The Service Orchestrator must support three tenant states: active (read/write), write-locked (read-only; uploads and bucket creation blocked), and disabled (all access blocked; data persisted). These restrictions must be enforced by the S3 gateway.

The Service Orchestrator must also expose a tenant deletion endpoint that permanently removes the tenant and all owned resources (buckets, objects, access keys). Deletion requires the tenant to be in the disabled state first, so the caller has to consciously cut off all access before committing to the destructive operation.

All management API operations are authenticated with a single partner API key. This key is not tenant-specific and grants administrative access across all tenants belonging to the FilOne partner account. The Service Orchestrator must scope this key so that it cannot access tenants belonging to other partners.

The entire tenant lifecycle — from creation through credential provisioning to full readiness — must be API-driven with no manual steps (no portal clicks, email verification, or human-in-the-loop approvals).

## Bucket Management

FilOne web Console manages buckets via the standard S3 API. FilOne's UI lets users create, list, inspect, and delete buckets.

Bucket creation accepts a name and several optional settings: versioning enabled, Object Lock enabled, and a default retention policy (mode – either GOVERNANCE or COMPLIANCE – plus a duration with its unit). Buckets are always created with server-side encryption enabled. The Service Orchestrator should return a clear error (HTTP 409 or equivalent) if a bucket with the same name already exists within the tenant, so that FilOne can show a user-friendly message.

Deleting a bucket should fail if the bucket still contains objects. If the Service Orchestrator does not yet support bucket deletion, it should communicate this so that FilOne can adapt its UI accordingly.

## S3 Access Key Management

End-users manage their own S3 access keys through the FilOne console. The Service Orchestrator must support creating, listing, retrieving, and deleting access keys through the management API. When a user creates an access key, FilOne sends the key name, a set of permissions, an optional list of buckets (for scoped access), and an optional expiration date.

FilOne uses AWS S3 IAM action names as permission scopes. The Service Orchestrator maps each value to its native permission model when creating the key.

Bucket-level scopes:

- `s3:CreateBucket`, `s3:ListAllMyBuckets`, `s3:DeleteBucket`.

Object-level scopes — the basic actions (`s3:GetObject`, `s3:PutObject`, `s3:ListBucket`, `s3:DeleteObject`) cover the common case, with variant actions for operations on versions, retention policies, and legal holds:

- `s3:GetObject`, `s3:GetObjectVersion`, `s3:GetObjectRetention`, `s3:GetObjectLegalHold`
- `s3:PutObject`, `s3:PutObjectRetention`, `s3:PutObjectLegalHold`
- `s3:ListBucket`, `s3:ListBucketVersions`
- `s3:DeleteObject`, `s3:DeleteObjectVersion`

Note the AWS quirk that `s3:ListBucket` lists _objects_ in a bucket, while `s3:ListAllMyBuckets` lists buckets.

The Service Orchestrator must support at least this level of granularity, or an equivalent permission scheme that lets keys be restricted to specific operations.

Deleting an access key should revoke the key immediately so that subsequent S3 requests using those credentials fail.

## Usage Metrics API

FilOne relies on the Service Orchestrator for all usage data. The Service Orchestrator must expose two time-series metrics endpoints, each returning storage, egress, and ingress data together for a specified time range:

- `GET /tenants/{tenantId}/metrics` — tenant-level usage.
- `GET /tenants/{tenantId}/buckets/{bucketName}/metrics` — per-bucket usage.

For storage, FilOne queries hourly samples of bytes used and object count. The dashboard also
queries storage metrics with a wider window (30 days, single sample) for a quick current-usage
snapshot.

For egress (outbound data transfer), FilOne queries egress consumption in bytes aggregated in
24-hour windows.

Minimum requirements for metrics endpoints:

- Query range (`to` − `from`): at least 32 days (covers a 31-day billing period with a one-day buffer).
- Supported windows: at least `1h`, `24h`, and `720h`.
- Response capacity: at least 768 samples per request (32 days ÷ 1 h — the highest-resolution, longest-range query FilOne issues).

Reliability of these endpoints is important.

## Non-Functional Requirements

**Idempotency.** Several operations must be safely retried: tenant creation (return existing on  
conflict), access key creation (return conflict error so FilOne can recover), access key deletion  
(succeed if already deleted), and tenant status updates (setting the same status twice is a no-op).  
Every step of the onboarding and every background job must handle duplicate invocations without side  
effects.

**Tenant isolation.** Each tenant's data must be invisible and inaccessible to  
other tenants, even if they share the same underlying infrastructure. S3  
credentials for one tenant must not grant access to another tenant's buckets  
or objects. The management API must enforce tenant scoping so that a per-tenant  
API key cannot operate on a different tenant's resources.

**Telemetry metrics from the S3 Gateway.**

- S3 GetObject Time-to-First-Byte
- S3 Error Rate (4xx)
- S3 Error Rate (5xx)
- S3 Total Requests (count per second or per minute)
- S3 Egress (bytes per second or per minute)
- S3 Ingress (bytes per second or per minute)
