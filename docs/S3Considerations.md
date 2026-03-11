# S3-Compatible SDK & CLI for a Non-AWS Provider

## How S3 Compatibility Works

The S3 API is a **REST API over HTTP/HTTPS** using standard HTTP methods. Any storage system that implements the same URL structure, request/response formats, and authentication scheme can be used as a drop-in replacement with existing S3 clients.

## The Core S3 REST API Surface

The operations you'd need to implement fall into three groups, with priority levels:

- **P0** -- Most used and basic operations; required to make this usable at all
- **P1** -- Important for real-world usage; needed to support common workflows and larger files
- **P2** -- Seldom used features, quality-of-life, or syntactic sugar over other operations

### Service-level operations

| Priority | Method | Path | Operation   | Notes                         |
| -------- | ------ | ---- | ----------- | ----------------------------- |
| **P0**   | `GET`  | `/`  | ListBuckets | Every client calls this first |

### Bucket-level operations

| Priority | Method   | Path                   | Operation            | Notes                                                    |
| -------- | -------- | ---------------------- | -------------------- | -------------------------------------------------------- |
| **P0**   | `PUT`    | `/{bucket}`            | CreateBucket         | Required for initial setup                               |
| **P0**   | `GET`    | `/{bucket}`            | ListObjectsV2        | Core browsing; used by every S3 client and CLI           |
| **P0**   | `HEAD`   | `/{bucket}`            | HeadBucket           | Used by SDKs to check bucket existence before operations |
| **P1**   | `DELETE` | `/{bucket}`            | DeleteBucket         | Less frequent; bucket must be empty first                |
| **P1**   | `GET`    | `/{bucket}?uploads`    | ListMultipartUploads | Needed to manage/clean up in-progress multipart uploads  |
| **P2**   | `GET`    | `/{bucket}?versioning` | GetBucketVersioning  | Only needed if versioning is supported                   |
| **P2**   | `PUT`    | `/{bucket}?versioning` | PutBucketVersioning  | Only needed if versioning is supported                   |
| **P2**   | `GET`    | `/{bucket}?tagging`    | GetBucketTagging     | QoL; metadata can be managed out-of-band                 |
| **P2**   | `PUT`    | `/{bucket}?tagging`    | PutBucketTagging     | QoL; metadata can be managed out-of-band                 |

### Object-level operations

| Priority | Method   | Path                                      | Operation                           | Notes                                                                   |
| -------- | -------- | ----------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| **P0**   | `PUT`    | `/{bucket}/{key}`                         | PutObject                           | Core write path                                                         |
| **P0**   | `GET`    | `/{bucket}/{key}`                         | GetObject                           | Core read path                                                          |
| **P0**   | `DELETE` | `/{bucket}/{key}`                         | DeleteObject                        | Core delete path                                                        |
| **P0**   | `HEAD`   | `/{bucket}/{key}`                         | HeadObject                          | Used by SDKs/CLI to check existence and get metadata                    |
| **P1**   | `POST`   | `/{bucket}/{key}?uploads`                 | CreateMultipartUpload               | Required for files >5GB; SDKs auto-use for large uploads                |
| **P1**   | `PUT`    | `/{bucket}/{key}?partNumber=N&uploadId=X` | UploadPart                          | Required for multipart upload                                           |
| **P1**   | `POST`   | `/{bucket}/{key}?uploadId=X`              | CompleteMultipartUpload             | Required for multipart upload                                           |
| **P1**   | `DELETE` | `/{bucket}/{key}?uploadId=X`              | AbortMultipartUpload                | Needed to clean up failed multipart uploads                             |
| **P1**   | `POST`   | `/{bucket}?delete`                        | DeleteObjects (batch)               | SDKs/CLI use this for bulk deletes (e.g., `aws s3 rm --recursive`)      |
| **P2**   | `PUT`    | `/{bucket}/{key}` + `x-amz-copy-source`   | CopyObject                          | Sugar; clients can GET + PUT instead. Used by `aws s3 cp s3://a s3://b` |
| **P2**   | `GET`    | `/{bucket}/{key}?tagging`                 | GetObjectTagging                    | QoL for metadata workflows                                              |
| **P2**   | `PUT`    | `/{bucket}/{key}?tagging`                 | PutObjectTagging                    | QoL for metadata workflows                                              |
| **P2**   | --       | Presigned URL generation                  | GetObject / PutObject via presigned | Sugar; enables sharing time-limited URLs without SDK                    |

### URL Addressing Styles

S3 supports two URL styles. Your server needs to handle at least one:

- **Path-style**: `https://s3.example.com/bucket-name/key` -- simpler to implement
- **Virtual-hosted style**: `https://bucket-name.s3.example.com/key` -- requires wildcard DNS

---

## The Critical Piece: AWS Signature Version 4 (SigV4)

This is the hardest part of S3 compatibility. Every request is authenticated using [AWS Signature Version 4](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html). Your server must:

1. **Parse the `Authorization` header** -- format:

   ```
   AWS4-HMAC-SHA256 Credential=AKID/20260216/us-east-1/s3/aws4_request,
   SignedHeaders=host;x-amz-content-sha256;x-amz-date,
   Signature=<hex-signature>
   ```

2. **Reconstruct the canonical request** from the incoming HTTP request (method, URI, query string, headers, payload hash)

3. **Derive the signing key** using HMAC-SHA256 chain:

   ```
   DateKey           = HMAC-SHA256("AWS4" + SecretKey, Date)
   DateRegionKey     = HMAC-SHA256(DateKey, Region)
   DateRegionService = HMAC-SHA256(DateRegionKey, "s3")
   SigningKey        = HMAC-SHA256(DateRegionService, "aws4_request")
   ```

4. **Compare signatures** -- if your computed signature matches the client's, the request is authenticated

5. **Handle chunked uploads** -- for `Transfer-Encoding: chunked`, each chunk carries its own signature derived from the previous chunk's signature (chain-signed, similar to a blockchain)

---

## Options for Building This

### Option A: Build an S3-Compatible Server from Scratch

Write an HTTP server that implements the S3 REST API and routes requests to your custom storage backend. Libraries that help:

| Language | Library                                                                          | What it does                                      |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| .NET     | [S3Server](https://github.com/jchristn/S3Server)                                 | Parses S3 HTTP requests, routes to your callbacks |
| Go       | Build on `net/http` + reference [MinIO's source](https://github.com/minio/minio) | MinIO's codebase is the gold standard reference   |
| Python   | `flask`/`fastapi` + manual SigV4                                                 | Full control but more work                        |
| Rust     | `s3s` crate                                                                      | S3 server framework                               |

**You implement**: the storage logic (put/get/delete objects on your backend -- e.g., Filecoin/IPFS, local disk, database, etc.)

**The framework handles**: HTTP parsing, request routing, XML serialization of S3 responses

### Option B: Fork MinIO as the S3-Compatible Data Plane (Preferred)

Fork [MinIO](https://min.io/) and replace its storage backend to create an S3-compatible endpoint that provides familiar access control semantics on top of Filecoin's public immutable store. MinIO is a production-grade S3-compatible server written in Go that handles the hardest parts of S3 compatibility (SigV4, XML serialization, multipart upload state machines) out of the box.

**Key constraint**: Bulk data (potentially hundreds of TB) cannot flow through AWS due to egress costs. The MinIO fork must be hosted on a **low-egress provider**, with only lightweight API calls (auth, key management, metadata) reaching your AWS-hosted web services.

#### Architecture

```
                   Low-egress provider                              AWS
                   (data plane)                                     (control plane)
                   ─────────────────                                ────────────────

Client ◄──TLS──► MinIO Fork                                    Your Web Service APIs
                    │                                               │
                    ├─ Auth ──────────── API call ───────────────► User / org lookup
                    │                    (small payload)            │
                    ├─ Encryption key ── API call ───────────────► Key management
                    │                    (small payload)            │
                    ├─ Metadata ops ──── API call ───────────────► Object index, ACLs
                    │                    (small payload)            │
                    │                                               │
                    ├─ Encrypt / decrypt locally using key          │
                    │                                               │
                    └─ Storage I/O ──────► Onramp ──────────────► Filecoin
                       (bulk data,
                        stays off AWS)
```

#### What MinIO Gives You for Free

MinIO already implements the full S3 protocol surface. Forking it means you inherit:

- **SigV4 authentication** -- the entire signing/verification flow
- **XML request/response serialization** -- all S3 response formats
- **Multipart upload state machine** -- chunking, part tracking, completion/abort
- **`ListObjectsV2`** with prefix/delimiter -- virtual folder browsing
- **Presigned URL generation** -- time-limited access tokens
- **`Expect: 100-continue`** handling
- **Range request support** -- partial object retrieval
- **Error response format** -- correct S3 error codes and XML structure
- **Health check / readiness endpoints**

This is months of protocol implementation you don't have to write.

#### What You Replace in the Fork

| MinIO component                | Replace with                                                              | Purpose                                                                  |
| ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Disk/erasure storage layer** | Calls to onramp API for Filecoin storage                                  | Swap local disk I/O for Filecoin put/get via onramp                      |
| **IAM / identity system**      | Calls to your AWS-hosted web service APIs                                 | Auth and permission checks against your user/org model                   |
| **Built-in bucket metadata**   | Calls to your AWS-hosted metadata service                                 | Object index, ACLs, bucket config stored in your DB                      |
| **Built-in encryption (SSE)**  | Encryption using keys fetched from your AWS-hosted key management service | See EncryptionKeyManagement.md for details on key hierarchy and rotation |

#### What Stays on the Low-Egress Provider

| Component                  | Size/bandwidth | Notes                                                           |
| -------------------------- | -------------- | --------------------------------------------------------------- |
| MinIO fork process(es)     | Compute only   | Stateless; can scale horizontally                               |
| TLS termination            | --             | Handles client connections                                      |
| Ephemeral cache (optional) | Configurable   | Cache hot objects locally to avoid repeated Filecoin retrievals |
| Bulk data transit          | Hundreds of TB | Client ↔ MinIO fork ↔ Onramp -- never touches AWS               |

#### What Goes to AWS (Small Payloads Only)

| API call                      | Payload size | Frequency                    |
| ----------------------------- | ------------ | ---------------------------- |
| Auth / SigV4 key lookup       | ~1 KB        | Every request                |
| Encryption key retrieval      | ~256 bytes   | Every PUT/GET of object data |
| Object metadata CRUD          | ~1-5 KB      | Every S3 operation           |
| Bucket ACL / permission check | ~1 KB        | Every request                |

At hundreds of TB of object data, these control-plane calls are negligible -- likely single-digit GB/month of AWS traffic.

#### Hosting the MinIO Fork

MinIO does **not** require Kubernetes. It runs as:

- A standalone binary (`minio server /data`)
- A Docker container
- On Kubernetes via the MinIO Operator (most complex)

For the low-egress data plane, a VM or container on any provider with zero egress fees works. See [this comparison of managed Kubernetes providers without egress fees](https://colan.pro/blog/comparison-of-managed-kubernetes-providers-without-egress-fees/) for options. Key considerations:

- The MinIO fork is **stateless** (all persistent state lives in AWS), so storage limitations on these providers matter less -- you mainly need compute and network bandwidth
- Benchmark network throughput before committing -- for hundreds of TB, you need sustained Gbps
- Smaller providers have less DDoS protection than hyperscalers; the S3 endpoint is a public API surface

#### Risks and Mitigations

| Risk                                | Impact                                                                               | Mitigation                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **AWS API latency**                 | Every S3 request requires a round-trip to AWS for auth + key lookup, adding 50-200ms | Cache auth sessions and keys locally with short TTLs (e.g., 5 min). Reduces per-request AWS calls.            |
| **AWS API unavailability**          | If AWS services are down, the MinIO fork can't authenticate or decrypt               | Local cache allows degraded-mode reads for cached objects. New uploads fail until AWS is back.                |
| **Low-egress provider instability** | Smaller providers have less redundancy                                               | Run MinIO fork across 2+ zones or providers. Stateless design makes failover straightforward.                 |
| **Network throughput limits**       | Smaller providers may cap bandwidth                                                  | Benchmark before committing. Ask providers about dedicated bandwidth options.                                 |
| **Fork maintenance**                | Upstream MinIO updates won't auto-merge                                              | Keep changes modular (storage backend interface, auth adapter). Minimize diff from upstream to ease rebasing. |

#### MinIO Gateway Deprecation Note

MinIO's gateway mode (which proxied S3 to other backends inline) [has been deprecated](https://blog.min.io/deprecation-of-the-minio-gateway/). The fork approach is different -- you're replacing the storage layer in the full server, not using the gateway. This is the path MinIO themselves recommend for custom backends.

### Option C: Build a Client SDK/CLI That Talks to Your Custom Backend

If your backend already has its own API, you can build an **SDK wrapper** that presents an S3-compatible interface to callers while translating internally:

```
Your SDK (S3-compatible interface)
    -> translates to your native API calls
        -> hits your actual storage backend
```

This is how [Cloudflare R2](https://developers.cloudflare.com/r2/api/s3/api/), [Backblaze B2](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api), [Oracle OCI](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi.htm), and [Storj](https://www.storj.io/object-storage/s3-compatibile-storage) all work.

---

## How Existing S3 Clients Connect to Custom Providers

The key configuration is the **endpoint URL**. All AWS SDKs and the CLI support this:

**AWS CLI:**

```bash
aws s3 ls --endpoint-url https://your-s3-server.example.com
```

**Python (boto3):**

```python
import boto3
s3 = boto3.client('s3',
    endpoint_url='https://your-s3-server.example.com',
    aws_access_key_id='YOUR_KEY',
    aws_secret_access_key='YOUR_SECRET',
)
```

**JavaScript (AWS SDK v3):**

```javascript
import { S3Client } from '@aws-sdk/client-s3';
const client = new S3Client({
  endpoint: 'https://your-s3-server.example.com',
  region: 'auto',
  credentials: { accessKeyId: 'KEY', secretAccessKey: 'SECRET' },
});
```

---

## Implementation Roadmap

A practical phased approach aligned with the priority levels above:

### Phase 1 -- P0: Minimum Viable Product

- SigV4 authentication
- `PutObject`, `GetObject`, `DeleteObject`, `HeadObject`
- `CreateBucket`, `ListBuckets`, `HeadBucket`
- `ListObjectsV2` (with prefix/delimiter for "folder" browsing)
- Proper XML response serialization (S3 uses XML, not JSON)

### Phase 2 -- P1: Real-World Usability

- Multipart upload (`CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`)
- `DeleteBucket`
- `DeleteObjects` (batch)
- `ListMultipartUploads`

### Phase 3 -- P2: Quality of Life & Advanced Features

- `CopyObject`
- Presigned URLs
- Bucket/object tagging
- Versioning
- Object locking / retention
- Lifecycle policies
- Event notifications (S3 Events -> SNS/SQS/Lambda equivalent)
- S3 Select
- Server-side encryption

---

## Hooks / Extension Points for Custom Operations

> Not sure we really need these custom operations, but it might be worth considering in a "P3" kinda way.

If you want to do **custom operations beyond standard S3** (e.g., Filecoin deal-making, CID retrieval, proof verification), you have several mechanisms:

1. **Object metadata** (`x-amz-meta-*` headers) -- attach custom key-value pairs to objects on upload, return them on download
2. **Custom HTTP headers** -- your server can accept/return non-standard headers
3. **Bucket/object tagging** -- S3's tagging API lets you associate arbitrary tags
4. **Lifecycle/event hooks** -- trigger custom backend operations when objects are created/deleted
5. **Custom query parameters** -- extend the API surface with provider-specific parameters
6. **Separate management API** -- keep S3 for data plane, add a custom REST API for control plane operations (this is what most providers do)

---

## Access Control

Since Filecoin stores data on a public, immutable network, traditional access control (filesystem permissions, network ACLs) does not apply. **Encryption is the access control mechanism** — whoever can decrypt the data has access, and revoking access means revoking key access.

### Access Control Model

Access is enforced at two layers that work together:

| Layer                              | What it controls                    | Mechanism                                                                                                           |
| ---------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **API key authentication** (SigV4) | Who can call the S3 endpoint at all | Access key / secret key pair issued by your console                                                                 |
| **Encryption key authorization**   | Who can read the actual data        | Whether the authenticated identity is permitted to trigger decryption of the wrapping key for a given bucket/object |

Authentication alone is not sufficient — even if a user has valid API credentials, they should only be able to decrypt objects they're authorized to access. The wrapping key (MEK) is the enforcement point.

### Permission Model

Permissions are scoped and enforced server-side in your console/control plane:

| Scope            | Description                                           | Example                                                                              |
| ---------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Organization** | Top-level tenant isolation; each org has its own MEKs | Org A cannot access Org B's buckets or keys                                          |
| **Bucket**       | Each bucket can have its own wrapping key and ACL     | `s3://analytics` is read-only for data team, read-write for pipeline service account |
| **Prefix**       | Optional finer-grained scoping within a bucket        | `s3://shared/team-alpha/*` accessible only by team-alpha's API keys                  |
| **Object**       | Per-object DEKs provide cryptographic isolation       | Compromise of one object's DEK does not expose any other object                      |

### How Access Control Maps to Operations

| S3 Operation    | Access check                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PutObject`     | API key must have write permission on the target bucket/prefix. Server generates a new DEK, encrypts, and stores.                                                             |
| `GetObject`     | API key must have read permission on the target bucket/prefix. Server retrieves the wrapped DEK, checks authorization to unwrap via the MEK, decrypts, and returns plaintext. |
| `DeleteObject`  | API key must have delete permission. Server removes metadata/index entry. On-chain ciphertext remains but becomes unlinkable.                                                 |
| `ListObjectsV2` | API key must have list permission on the bucket. Only returns object keys the caller is authorized to see.                                                                    |
| `HeadObject`    | Same as GetObject but returns only metadata (no decryption needed unless metadata itself is encrypted).                                                                       |

### Access Revocation

Because Filecoin is immutable, "deleting" data means making it unreadable:

| Action                        | Effect                                                       | Data on Filecoin                                                                    |
| ----------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| **Revoke API key**            | User can no longer call the endpoint                         | Unchanged — ciphertext remains but user has no path to request decryption           |
| **Remove bucket permission**  | User can authenticate but gets `AccessDenied` on that bucket | Unchanged                                                                           |
| **Delete wrapping key (MEK)** | All objects under that MEK become permanently unreadable     | Ciphertext remains but is cryptographically inaccessible                            |
| **Rotate wrapping key**       | Re-wrap DEKs with new MEK; old MEK can be destroyed          | Unchanged — only metadata DB is updated (see EncryptionKeyManagement.md Appendix A) |

### Sharing and Delegation

| Pattern                              | How it works                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Share a bucket with another user** | Grant their API key read permission on the bucket; server handles decryption on their behalf             |
| **Time-limited access**              | Issue a presigned URL (P2 feature) — embeds temporary credentials in the URL, expires after a set period |
| **Cross-org sharing**                | Create a shared bucket with a dedicated MEK; grant both orgs' API keys permission to that MEK            |
| **Service account access**           | Issue a dedicated API key pair with scoped permissions for CI/CD, backup agents, etc.                    |

### Key Principle

Access control is **not** enforced by obscuring the CID or hiding the ciphertext on Filecoin — it is always enforced by controlling who can trigger decryption through your key management layer. The data on-chain is assumed to be publicly visible. Security depends entirely on the encryption and key access controls.

---

## Recommendation

Given the context of this project (Filecoin/Fil.one):

1. **Server-side**: Build an S3-compatible HTTP server (Go or Rust recommended for performance) that translates S3 operations to your storage backend. Use MinIO's source code as your reference implementation. (Or fork MinIO?)
2. **Client SDK**: Let users use the **standard AWS SDKs** with a custom `endpoint_url` -- this gives you instant compatibility with every language.
3. **CLI**: Let users use the **standard `aws` CLI** with `--endpoint-url`, or build a thin wrapper CLI that pre-configures the endpoint.
4. **Custom operations**: Expose via a separate management API or via `x-amz-meta-*` headers on the S3 API.

---

## Appendix A: Client-Side Footprint When Using S3 API Directly

When using the S3-compatible endpoint approach, **no custom code runs on the user's machine**. Users bring their own standard S3 tooling.

### What Lives Where

**On the user's machine:**

- The standard `aws` CLI or any AWS SDK (boto3, etc.) -- software they already have or install from AWS/pip/npm
- A config with three values:
  ```
  endpoint_url = https://your-api.filone.example.com
  aws_access_key_id = HS_XXXXXXXXXXXX
  aws_secret_access_key = HS_YYYYYYYYYYYYYYYYYYYY
  ```
- That's it. No custom binary, no agent, no plugin.

**On your side (console/backend):**

- **Key management**: Your console generates access key / secret key pairs, stores the secret (or a hash of it), and associates each pair with a user/org/permissions
- **SigV4 verification**: When a request comes in, you look up the secret by the access key ID, recompute the signature, and compare
- **Permission enforcement**: You map the key pair to whatever CRUD permissions / bucket ACLs you define in your console
- **Audit/billing**: Every authenticated request is attributable to a key pair, so you get logging and metering for free

### Request Flow

```
User's machine                         Your infrastructure
─────────────                          ────────────────────

aws s3 cp file.txt s3://mybucket/
    │
    ├─ Signs request with their
    │  secret key (SigV4)
    │
    ├─ PUT /mybucket/file.txt ────────►  S3-compatible endpoint
    │  Authorization: AWS4-HMAC-SHA256       │
    │  Credential=HS_XXX/...                 ├─ Look up HS_XXX in your DB
    │                                        ├─ Retrieve stored secret
    │                                        ├─ Recompute signature
    │                                        ├─ Match? → authorized
    │                                        ├─ Check CRUD permissions
    │                                        ├─ Route to storage backend
    │                                        ├─ Return S3 XML response
    │                                        │
    ◄──────── 200 OK + ETag ────────────────┘
```

### Secret Key Security Model

The secret key **never leaves the user's machine over the wire**. SigV4 is designed so that:

1. The user's SDK uses the secret to **sign** the request (HMAC-SHA256)
2. Only the **signature** is sent in the `Authorization` header
3. Your server independently computes the same signature using its stored copy of the secret
4. If they match, the request is authentic

This is the same model as AWS itself -- the secret is a shared secret used for signing, never transmitted. Your console is the issuer and your endpoint is the verifier. You control the full lifecycle: create, rotate, revoke, scope permissions -- all in your console.

### Console Key Management Features

| Console feature      | What it controls                                                 |
| -------------------- | ---------------------------------------------------------------- |
| Create API key pair  | Issues `access_key_id` + `secret_access_key`                     |
| Revoke / rotate keys | Invalidate old keys, issue new ones                              |
| Permission scoping   | Which buckets/prefixes a key can access, read-only vs read-write |
| Rate limits / quotas | Throttle per key pair                                            |
| Audit logs           | Every request tied to a key pair                                 |
| Billing / metering   | Track storage and bandwidth per key                              |

---

## Appendix B: Tradeoffs -- S3-Compatible Endpoint vs. Bespoke SDK

|                             | S3-compatible (aws CLI/SDK + custom endpoint)                                                                                                                                              | Bespoke SDK/CLI                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **Client development cost** | Zero -- use existing AWS SDKs in every language                                                                                                                                            | Must build + maintain SDKs per language (Python, JS, Go, etc.)         |
| **Ecosystem compatibility** | Works with Terraform S3 backend, rclone, Cyberduck, every backup tool, Kubernetes CSI drivers                                                                                              | Works with nothing else until you build integrations                   |
| **User onboarding**         | Developers already know `aws s3 cp`                                                                                                                                                        | New CLI, new concepts, new docs to learn                               |
| **Server development cost** | **Higher** -- must implement SigV4, XML serialization, exact header/error contracts                                                                                                        | **Lower** -- use JSON, any auth you want (API keys, JWT, OAuth)        |
| **Custom operations**       | **Constrained** -- Filecoin-specific ops (deal status, CID lookup, retrieval proofs) have no S3 equivalent. Limited to `x-amz-meta-*` headers (2KB max, string-only) or a side-channel API | **Full control** -- first-class support for domain-specific operations |
| **Error semantics**         | Must return S3 error codes; can't express domain-specific errors naturally (e.g., "deal not sealed yet")                                                                                   | Rich, domain-specific error responses                                  |
| **API evolution**           | Locked to S3's API surface; adding new operations means stepping outside the S3 contract                                                                                                   | Evolve freely                                                          |
| **Discoverability**         | Users won't know what you support vs. don't without trial-and-error (e.g., does versioning work? lifecycle?)                                                                               | Your SDK only exposes what exists                                      |

### Most Providers Do Both

Nearly every successful S3-compatible provider (Cloudflare R2, Backblaze B2, Storj, MinIO) ships both:

1. **An S3-compatible endpoint** for ecosystem compatibility -- so users can plug in existing tools, Terraform, rclone, etc.
2. **A native/bespoke API** for provider-specific features -- R2 has its Workers API, B2 has its native API, Storj has its native gRPC API

```
┌─────────────────────────────────────────────┐
│              Your Storage Backend            │
│         (Filecoin / IPFS / Fil.one)       │
└──────────────┬──────────────┬───────────────┘
               │              │
     ┌─────────▼────────┐  ┌─▼──────────────────┐
     │  S3-Compatible    │  │  Native API         │
     │  Endpoint         │  │  (REST/gRPC, JSON)  │
     │                   │  │                     │
     │  • SigV4 auth     │  │  • Your own auth    │
     │  • XML responses  │  │  • Deal status      │
     │  • Bucket/key ops │  │  • CID lookups      │
     │  • Standard CRUD  │  │  • Retrieval proofs  │
     │                   │  │  • Storage policies  │
     └─────────┬─────────┘  └──┬──────────────────┘
               │               │
     Used by: aws CLI,       Used by: your CLI,
     Terraform, rclone,      your SDK, dashboard,
     boto3, existing apps    admin tools
```

The S3 layer gets you instant adoption. The native API gives you room to be expressive about what makes your storage different. They share the same backend -- the S3 endpoint is just a translation layer on top.

---

## Appendix C: Timeout and Retry Considerations for Slow Retrievals

### The Problem

S3 SDKs and the CLI have aggressive default timeouts designed for AWS's sub-second response times. Filecoin retrievals involve unsealing and network hops that can take seconds to minutes. Without mitigation, most SDK defaults will timeout before data arrives.

**Default read timeouts across SDKs:**

| SDK / Tool        | Connect Timeout | Read Timeout |
| ----------------- | --------------- | ------------ |
| AWS CLI           | 60s             | 60s          |
| Python (boto3)    | 60s             | 60s          |
| Java SDK v2       | 2s              | 30s          |
| .NET SDK          | 100s            | 300s         |
| JavaScript SDK v3 | --              | 120s         |

The **read timeout** is the max wait for the next chunk of data on an open connection. If your Filecoin retrieval has 30+ seconds of silence before the first byte, Java SDK users will get a `ReadTimeoutException` by default.

Worse, when a timeout fires the SDK **retries automatically** (2-4 times with exponential backoff). Each retry hits your server and potentially triggers a new unsealing operation, creating a thundering herd effect.

### Server-Side Mitigations

| Mitigation                                    | Priority | Description                                                                                                                                                                                      |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Return headers immediately, stream data later | **P0**   | Respond with `200 OK` + `Transfer-Encoding: chunked` as soon as auth succeeds. Begin Filecoin retrieval in the background and stream chunks as they arrive. This resets the client's read timer. |
| Send keepalive chunks during silence          | **P0**   | If there's a long pause waiting for Filecoin data, send minimal chunks to keep the connection alive and prevent read timeouts (is it possible to get any streamed data? I suspect no.).          |
| Support `Range` requests                      | **P1**   | Return `Accept-Ranges: bytes` so SDKs can retry partial failures without re-downloading the entire object.                                                                                       |
| Respect `Expect: 100-continue`                | **P1**   | For uploads, respond with `100 Continue` immediately before processing. SDKs send this by default.                                                                                               |

### Client-Side Configuration (Document for Users)

Users should be told to increase timeouts. Provide a recommended config profile (numbers likely need to be larger):

**AWS CLI:**

```bash
aws s3 cp s3://bucket/key ./file \
  --endpoint-url https://api.filone.example.com \
  --cli-read-timeout 300 \
  --cli-connect-timeout 60
```

**Python (boto3):**

```python
from botocore.config import Config
s3 = boto3.client('s3',
    endpoint_url='https://api.filone.example.com',
    config=Config(
        read_timeout=300,
        connect_timeout=60,
        retries={'max_attempts': 2}
    )
)
```

**Recommended**: Ship a wrapper CLI or pre-configured AWS config profile that sets these defaults so users don't have to.

---

## References

- [AWS S3 REST API Reference](https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html)
- [AWS SigV4 Authentication](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html)
- [SigV4 Authorization Header](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-auth-using-authorization-header.html)
- [MinIO -- S3 Compatible Object Store](https://github.com/minio/minio)
- [S3Server (.NET)](https://github.com/jchristn/S3Server)
- [Cloudflare R2 S3 API Compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [Backblaze B2 S3-Compatible API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api)
- [Oracle OCI S3 Compatibility](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi.htm)
- [MinIO Gateway Deprecation](https://blog.min.io/deprecation-of-the-minio-gateway/)
- [LabStore -- Building SigV4 Auth in Go](https://datalabtechtv.com/posts/labstore-part-2-sigv4-auth/)
