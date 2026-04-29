# **MSP Integration Requirements**

This document describes what FilOne needs from a managed service provider (MSP) to integrate it as a new FilOne region.

## **Summary**

APIs:

- Tenant management (isolated per-organisation accounts)
- Tenant statuses (active; write-locked; disabled)
- Per-Tenant API keys management
- S3 Access Key management
- S3 Gateway
- Usage metrics at tenant level (storage bytes, object count, egress bytes)

The MSP's S3 Gateway must implement the following features:

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
- _(eventually should have)_ Telemetry metrics for the S3 Gateway (TTFB, response times, 4xx/5xx error rates, etc.)

```
+---------------------------------------------------------+
|  MSP APIs                                               |
|                                                         |
|  +---------------------+  +--------------------------+  |
|  | Admin API           |  | Tenant Management API    |  |
|  | (global API key)    |  | (per-tenant API key)     |  |
|  |                     |  |                          |  |
|  | - Create tenant     |  | - Create/list/get/delete |  |
|  | - Setup tenant      |  |   access keys            |  |
|  | - Get tenant info   |  |                          |  |
|  | - Set tenant status |  |                          |  |
|  | - Create API key    |  |                          |  |
|  | - Query usage       |  |                          |  |
|  +---------------------+  +--------------------------+  |
|                                                         |
|  +----------------------------------------------------+ |
|  | S3 Gateway                                         | |
|  | (per-tenant access key + secret, AWS Sig V4)       | |
|  |                                                    | |
|  | - PutObject / GetObject (pre-signed URLs)          | |
|  | - ListObjectsV2, HeadObject, DeleteObject          | |
|  | - CreateBucket, ListBuckets, DeleteBucket          | |
|  | - GetObjectRetention                               | |
|  +----------------------------------------------------+ |
|                                                         |
+---------------------------------------------------------+
```

## **Tenant Management**

FilOne provisions one tenant per customer organisation. When a user signs up, FilOne kicks off an asynchronous onboarding flow that creates a new tenant with the MSP. The MSP must expose an API to create a tenant given a unique identifier (the FilOne org ID) and a human-readable display name. If the creation request is retried and the tenant already exists, the MSP must return the existing tenant rather than failing.

FilOne supports asynchronous tenant setup taking seconds to minutes to complete, as long as there is a way for FilOne to determine when the tenant is fully operational.

The MSP must support three tenant states: active (read/write), write-locked (read-only; uploads and bucket creation blocked), and disabled (all access blocked; data persisted). These restrictions must be enforced by the S3 gateway.

The MSP must also expose a tenant deletion endpoint that permanently removes the tenant and all owned resources (buckets, objects, access keys, per-tenant API keys). Deletion requires the tenant to be in the disabled state first, so the caller has to consciously cut off all access before committing to the destructive operation.

All tenant management operations are authenticated with a single global API key. This key is not tenant-specific and grants administrative access across all tenants belonging to the FilOne partner account. The MSP should scope this key so that it cannot access tenants belonging to other partners.

The entire tenant lifecycle — from creation through credential provisioning to full readiness — must be API-driven with no manual steps (no portal clicks, email verification, or human-in-the-loop approvals).

## **Per-Tenant API Keys**

After the tenant is created and set up, FilOne creates a per-tenant API key through the MSP's admin API. This key is scoped to a single tenant and is used for all subsequent tenant-level management calls: creating buckets, creating and deleting access keys, listing buckets, and so on. The MSP must return a secret token that FilOne can present in an HTTP header to authenticate these calls.

This separation limits the blast radius if a per-tenant key is compromised.

The MSP must also support **key rotation**: a tenant must be able to hold more than one active API key at the same time, so that FilOne can issue a new key, switch callers over to it, and only then revoke the old one. The standard flow is issue → switch → revoke; both keys are valid during the overlap window. Revocation is a separate endpoint that takes the key's identifier (returned by the create call) and is idempotent — calling it twice for the same key is not an error.

## **Bucket Management**

FilOne web Console manages buckets via the standard S3 API. FilOne's UI lets users create, list, inspect, and delete buckets.

Bucket creation accepts a name and several optional settings: versioning enabled, Object Lock enabled, and a default retention policy (mode – either GOVERNANCE or COMPLIANCE – plus a duration with its unit). Buckets are always created with server-side encryption enabled. The MSP should return a clear error (HTTP 409 or equivalent) if a bucket with the same name already exists within the tenant, so that FilOne can show a user-friendly message.

Deleting a bucket should fail if the bucket still contains objects. If the MSP does not yet support bucket deletion, it should communicate this so that FilOne can adapt its UI accordingly.

## **S3 Access Key Management**

End-users manage their own S3 access keys through the FilOne console. The MSP must support creating, listing, retrieving, and deleting access keys through the tenant-scoped management API (authenticated with the per-tenant API key). When a user creates an access key, FilOne sends the key name, a set of permissions, an optional list of buckets (for scoped access), and an optional expiration date.

FilOne uses AWS S3 IAM action names as permission scopes. The MSP maps each value to its native permission model when creating the key.

Bucket-level scopes:

- `s3:CreateBucket`, `s3:ListAllMyBuckets`, `s3:DeleteBucket`.

Object-level scopes — the basic actions (`s3:GetObject`, `s3:PutObject`, `s3:ListBucket`, `s3:DeleteObject`) cover the common case, with variant actions for operations on versions, retention policies, and legal holds:

- `s3:GetObject`, `s3:GetObjectVersion`, `s3:GetObjectRetention`, `s3:GetObjectLegalHold`
- `s3:PutObject`, `s3:PutObjectRetention`, `s3:PutObjectLegalHold`
- `s3:ListBucket`, `s3:ListBucketVersions`
- `s3:DeleteObject`, `s3:DeleteObjectVersion`

Note the AWS quirk that `s3:ListBucket` lists _objects_ in a bucket, while `s3:ListAllMyBuckets` lists buckets.

The MSP must support at least this level of granularity, or an equivalent permission scheme that lets keys be restricted to specific operations.

Deleting an access key should revoke the key immediately so that subsequent S3 requests using those credentials fail.

## **Usage Metrics API**

FilOne relies on the MSP for all usage data. The MSP must expose a time-series metrics API that returns storage and egress data for a given tenant over a specified time range.

For storage, FilOne queries hourly samples of bytes used and object count. The dashboard also  
queries storage metrics with a wider window (30 days, single sample) for a quick current-usage  
snapshot.

For egress (outbound data transfer), FilOne queries egress consumption in bytes aggregated in  
24-hour windows.

Reliability of this endpoint is important.

## **Non-Functional Requirements**

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

**Telemetry metrics from the S3 Gateway**

- S3 GetObject Time-to-First-Byte
- S3 Error Rate (4xx)
- S3 Error Rate (5xx)
- S3 Total Requests (count per second or per minute)
- S3 Egress (bytes per second or per minute)
- S3 Ingress (bytes per second or per minute)
