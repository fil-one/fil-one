# ADR: Lambda Provisioned Concurrency and SSM Caching for Critical-Path Endpoints

**Status:** Accepted
**Date:** 2026-03-30

---

## Context

The Hyperspace console API runs entirely on AWS Lambda + API Gateway V2. Every route is a separate Lambda function sharing a 512 MB memory allocation (set globally via `$transform`). Because the product is a low-to-moderate traffic SaaS console (not a high-volume API), Lambda functions routinely scale to zero between user sessions. This means almost every user interaction after a period of inactivity hits a cold start.

### Why Node.js Lambda cold starts were slow

Three independent factors compounded to produce 500–1500 ms user-perceived latency spikes:

**1. Node.js module initialization (~200–500 ms)**

Each Lambda handler imports the AWS SDK v3, SST Resource bindings, Stripe, Auth0 SDK, and other dependencies at module scope. On a cold start, the runtime loads all of these before executing the handler. Heavier functions — those that import multiple SDK clients and establish more module-level state — pay a larger initialization penalty. CloudWatch `Init Duration` values from the dev stage (Mar 26–31) confirm this range across the critical-path functions.

**2. SSM parameter fetches on every invocation**

Both `aurora-portal.ts` and `aurora-s3-client.ts` called `SSMClient.send(GetParameterCommand)` on every invocation to retrieve the Aurora Portal API key and Aurora S3 credentials. These calls typically add 100–300 ms per invocation. The parameters do not change between deploys, so the repeated fetches were pure overhead. On a warm instance, this meant every single request to ListBuckets, GetBucket, ListObjects, HeadObject, or PresignUpload paid an unnecessary SSM round-trip. On a cold start, this overhead stacked on top of the init duration.

**3. Aurora Backoffice API latency**

GetActivity and GetUsage make outbound calls to the Aurora Backoffice API. Measured warm-path execution for these functions averages 1094 ms and 550 ms respectively. This is not a cold start issue, but it means that for these high-frequency dashboard functions, eliminating the cold start overhead (460–541 ms init) provides the largest absolute user-visible improvement.

### Measured cold start impact (CloudWatch Logs Insights, dev stage, Mar 26–31)

Data sourced from `filone-joemuoio-*` log groups, all invocations from Mar 26 to Mar 31. The dev stage receives intermittent traffic, producing higher cold start rates than production would under steady-state load. Numbers reflect `$LATEST` invocations with no provisioned concurrency.

| Function         | Invocations | Cold Starts | CS Rate | Avg Init (ms) | Max Init (ms) | Avg Exec (ms) | Max Exec (ms) | Avg Mem (MB) |
| ---------------- | ----------- | ----------- | ------- | ------------- | ------------- | ------------- | ------------- | ------------ |
| `GetMe`          | 264         | 31          | 11.7%   | 423           | 538           | 139           | 3489          | 134          |
| `GetBilling`     | 149         | 36          | 24.2%   | 448           | 539           | 299           | 4271          | 140          |
| `GetUsage`       | 222         | 47          | 21.2%   | 416           | 541           | 550           | 4241          | 132          |
| `GetActivity`    | 110         | 27          | 24.5%   | 461           | 627           | 1094          | 6094          | 144          |
| `ListBuckets`    | 39          | 13          | 33.3%   | 465           | 534           | 1040          | 4929          | 143          |
| `GetBucket`      | 32          | 10          | 31.2%   | 460           | 494           | 1050          | 4962          | 142          |
| `ListObjects`    | 32          | 10          | 31.2%   | 484           | 554           | 992           | 5030          | 147          |
| `HeadObject`     | 6           | 2           | 33.3%   | 486           | 492           | 1085          | 1845          | 150          |
| `PresignUpload`  | 6           | 6           | 100%    | 486           | 521           | 559           | 611           | 150          |
| `ListAccessKeys` | 44          | 14          | 31.8%   | 452           | 490           | 324           | 3752          | 140          |
| `AuthCallback`   | 27          | 15          | 55.6%   | 233           | 249           | 397           | 792           | 101          |
| `AuthLogin`      | 39          | 16          | 41.0%   | 223           | 269           | 5             | 17            | 80           |

Key observations from the data:

- **Init duration adds 223–627 ms** to first-request latency across all critical-path functions. For functions like GetMe (called on every page load) or AuthCallback (blocks the entire login flow), this is directly user-visible.
- **SSM-heavy functions show high execution times on warm invocations**: ListBuckets, GetBucket, ListObjects, HeadObject, and GetActivity all average over 990 ms exec time even on warm instances because SSM fetches occur on each invocation. These functions benefit from both PC (eliminating init) and SSM caching (eliminating per-call SSM overhead).
- **Memory is well within the 512 MB allocation** for all functions (80–157 MB observed), confirming memory is not the bottleneck.
- **Max execution times up to 6094 ms** (GetActivity, ListBuckets, ListObjects) suggest occasional Aurora API latency spikes that compound with cold start overhead.
- **PresignUpload shows 100% cold start rate** at only 6 invocations, consistent with very infrequent use in the dev stage — this function is on the critical path (blocks upload start) but rarely exercised in testing.

### Why provisioned concurrency applies here

Without PC, Lambda keeps a function instance warm for a short window (typically minutes) after the last invocation. The console pattern — a user loads the dashboard, does some work, then goes idle — means this window frequently expires between page interactions, especially in off-hours or for infrequently visited pages. Provisioned concurrency keeps 1 instance pre-initialized in `READY` state at all times, eliminating the `Init Duration` from the critical path entirely.

For the versioned functions (with PC), CloudWatch REPORT records show no `Init Duration` field — confirming the pre-warmed instance was used and the 400–627 ms penalty was avoided.

## Options Considered

### Provisioned Concurrency (chosen)

AWS-native mechanism that pre-initializes a set number of function instances before any invocations arrive. Eliminates cold starts for steady-state traffic within the provisioned capacity. Requires publishing a function version (the PC config attaches to a specific version, not `$LATEST`) and routing API Gateway to the qualified ARN.

The main cost is the provisioned capacity charge (~$0.000004646/GB-second in us-east-2), charged whether invoked or not. At 512 MB × 1 instance × 12 functions, this is approximately **$72/month** regardless of traffic.

### Lambda SnapStart

AWS SnapStart (Firecracker microVM snapshot restore) eliminates init time by snapshotting the initialized runtime state and restoring from that snapshot on cold starts. As of 2026, SnapStart is only available for Java runtimes. The console API runs on Node.js 24.x. Not applicable.

### Scheduled warming (periodic keep-alive pings)

A CloudWatch Events rule could invoke each function on a schedule (e.g., every 5 minutes) to prevent scale-to-zero. This is a common workaround but has meaningful drawbacks: it is fragile (the warm instance may still be replaced by a new deployment or by AWS recycling), the ping logic must be explicitly handled by each function (or it will fail), and it does not provide the guarantee that PC does. Provisioned concurrency is the first-party solution for this use case.

### Increase memory allocation

Lambda allocates CPU proportionally to memory. Increasing from 512 MB to 1024 MB or 1769 MB can reduce execution time for CPU-bound handlers. However, Lambda cold start (`Init Duration`) is a fixed overhead for runtime and module initialization — it scales weakly with memory. Given that the bottleneck is module loading and SSM I/O, not CPU, higher memory would provide marginal init improvement at increased per-invocation cost. The observed memory ceiling of ~157 MB also confirms the current allocation is not pressure-constrained.

### Triage cold starts to acceptable functions only

Rather than eliminating all cold starts, only apply PC to functions where the user directly perceives the latency. Functions triggered by infrequent user actions (bucket creation, access key creation, logout, onboarding) tolerate cold starts because users expect some latency on those actions. This is the approach taken — PC is not applied universally.

## Decision

Apply provisioned concurrency (`provisioned: 1`) to the 12 functions on the critical user path, and add module-scope SSM caching to both Aurora client libraries.

### Provisioned concurrency: 12 critical-path functions

The following functions received `provisionedConcurrency: 1` in `sst.config.ts`:

| Function         | Route                                      | Cold start impact                                 |
| ---------------- | ------------------------------------------ | ------------------------------------------------- |
| `AuthLogin`      | `GET /login`                               | First step in auth flow; blocks login start       |
| `AuthCallback`   | `GET /api/auth/callback`                   | Auth0 token exchange; blocks login completion     |
| `GetMe`          | `GET /api/me`                              | Called on every page load for session validation  |
| `GetBilling`     | `GET /api/billing`                         | Stripe + DynamoDB; shown on every dashboard visit |
| `ListBuckets`    | `GET /api/buckets`                         | SSM + Aurora Portal; primary dashboard content    |
| `GetBucket`      | `GET /api/buckets/{name}`                  | SSM + Aurora Portal; bucket detail page load      |
| `ListObjects`    | `GET /api/buckets/{name}/objects`          | SSM + Aurora S3; object browser page load         |
| `HeadObject`     | `GET /api/buckets/{name}/objects/metadata` | SSM + dual Aurora calls; metadata panel load      |
| `PresignUpload`  | `POST /api/buckets/{name}/objects/presign` | SSM + Aurora S3; blocks upload start              |
| `ListAccessKeys` | `GET /api/access-keys`                     | DynamoDB; access keys page load                   |
| `GetUsage`       | `GET /api/usage`                           | Aurora Backoffice; dashboard widget               |
| `GetActivity`    | `GET /api/activity`                        | Aurora Backoffice + S3; dashboard widget          |

The following functions are **excluded** from PC because cold starts are tolerable at their call frequency:

| Function             | Route                                      | Reason                                    |
| -------------------- | ------------------------------------------ | ----------------------------------------- |
| `CreateBucket`       | `POST /api/buckets`                        | Infrequent; user expects creation latency |
| `CreateAccessKey`    | `POST /api/access-keys`                    | Infrequent                                |
| `DownloadObject`     | `GET /api/buckets/{name}/objects/download` | Presign redirect; slight delay acceptable |
| `ConfirmOrg`         | `POST /api/org/confirm`                    | One-time onboarding action                |
| `AuthLogout`         | `GET /logout`                              | Infrequent; redirect delay acceptable     |
| `ResendVerification` | `POST /api/me/resend-verification`         | Email delivery is already slow            |
| `ListInvoices`       | `GET /api/billing/invoices`                | Settings page; rarely visited             |

### SSM caching: module-scope LRU cache in Aurora client libraries

Both `aurora-portal.ts` and `aurora-s3-client.ts` cache SSM results in a module-scope `QuickLRU<string, string>` (from [`quick-lru`](https://www.npmjs.com/package/quick-lru)), keyed by `${stage}/${tenantId}`. On the first invocation within a Lambda instance, the SSM call executes as before. On subsequent calls within the same instance, the cached value is returned synchronously. A `_resetSsmCacheForTesting` export allows unit tests to clear cache state between test cases.

**Why LRU instead of an unbounded `Map`:** With PC = 1, a warm Lambda instance can live for hours and accumulate one cache entry per unique tenant it serves. An unbounded `Map` grows monotonically for the instance's lifetime with no eviction path. `QuickLRU` provides a principled ceiling: once `maxSize` is reached, the least-recently-seen tenant's entry is evicted and re-fetched from SSM on next access — a cache miss, not a failure.

**Why `maxSize: 500`:** The cache value is a small string (~40–150 bytes). At 500 entries the footprint is ~100 KB — negligible against the 512 MB allocation. 500 is well above the number of unique tenants any single Lambda instance will realistically accumulate before recycling at current scale, so eviction is effectively never triggered in practice. It exists as a safety bound if scale grows significantly.

### Memory allocation: 1024 MB for execution-bound functions

The same commit that introduced provisioned concurrency also set a global default of 512 MB via `$transform` (SST's prior default was 1024 MB). The reduction was intentional — PC cost scales with memory allocation, so halving the default from 1024 MB to 512 MB cut the provisioned concurrency bill roughly in half (~$72/month vs ~$144/month for 12 functions).

Lambda allocates CPU proportionally to memory. At 512 MB a function receives half the vCPU it would at 1024 MB. For functions whose execution time is dominated by compute or I/O concurrency (parallel SDK calls, JSON serialization of large payloads), the 512 MB reduction directly increases execution duration. The CloudWatch data shows five functions averaging over 900 ms on warm invocations:

| Function      | Avg Exec (512 MB) | Bottleneck                                  |
| ------------- | ----------------- | ------------------------------------------- |
| `GetActivity` | 1094 ms           | Aurora Backoffice API + S3 listing          |
| `HeadObject`  | 1085 ms           | Dual Aurora calls (S3 metadata + retention) |
| `GetBucket`   | 1050 ms           | Aurora Portal API call                      |
| `ListBuckets` | 1040 ms           | Aurora Portal API call                      |
| `ListObjects` | 992 ms            | Aurora S3 gateway call                      |

These five functions are restored to 1024 MB. The remaining seven PC-protected functions (GetMe at 139 ms avg, AuthLogin at 5 ms avg, etc.) and all non-PC functions remain at 512 MB — their execution times are not meaningfully CPU-bound at the current memory level.

The per-function `memory` prop on `addRoute` overrides the global `$transform` default, so this is surgical rather than a blanket revert.

### API Gateway routing to versioned ARN

SST's `api.route()` routes to a function ARN. For PC to take effect, the route must point to the **qualified ARN** (including the version qualifier), not `$LATEST`. The `addRoute` helper was updated to:

- Enable `versioning: true` on functions with `provisionedConcurrency > 0`, which causes SST/Pulumi to publish a new version on every deploy
- Pass `fn.nodes.function.qualifiedArn` to `api.route()` for versioned functions
- Add an explicit `aws.lambda.Permission` resource granting API Gateway invoke access on the qualified ARN, because SST's internal permission wiring does not include the version qualifier when given an ARN directly

The `criticalPathLambdaProvisionedConcurrency` constant in `sst.config.ts` acts as a single toggle: set to `0` (or `undefined`) to disable PC for all critical-path functions in a given stage.

## Consequences

- **Cold start eliminated for steady-state traffic**: With PC = 1 and API Gateway routing to the versioned ARN, all requests hitting the pre-warmed instance record no `Init Duration`. The 400–627 ms init penalty is removed from user-visible latency for the 12 covered functions.
- **SSM overhead eliminated after first warm invocation**: The module-scope cache means Aurora SSM parameters are fetched once per Lambda instance lifetime instead of once per request. Functions like ListBuckets and ListObjects that previously averaged 1040 ms exec time will see reduced execution times on warm invocations once the cache is populated.
- **Cold starts still occur on new deploys**: Publishing a new version (on every `sst deploy`) creates a fresh instance. PC has a 1–3 minute warm-up period after deploy before status moves from `IN_PROGRESS` to `READY`. During this window, a cold start is possible. This is expected behavior and is visible during development; production deployments should complete their PC warm-up before traffic is shifted.
- **PC does not protect $LATEST**: If a route or tool directly invokes `$LATEST` (e.g., manual `aws lambda invoke` during testing, or a misconfigured stage with `criticalPathLambdaProvisionedConcurrency = 0`), cold starts will still appear. This is visible in the dev stage metrics where sporadic tool invocations continue to show `Init Duration`.
- **Cost**: ~$104/month for provisioned concurrency in us-east-2 — 7 functions at 512 MB (~$43/month) plus 5 functions at 1024 MB (~$61/month), 1 provisioned instance each. This is up from the original ~$72/month estimate (12 × 512 MB) before the memory increase on the five execution-bound functions. This is a fixed cost independent of invocation count. Check AWS Cost Explorer under Lambda > `Provisioned-Concurrency` usage type.
- **Version management**: Every deploy to a PC-enabled stage publishes a new Lambda version. Old versions accumulate indefinitely — neither Terraform/Pulumi's AWS provider nor Lambda itself has a built-in retention limit for function versions. All versions across all functions in an account count against the 75 GB deployment package storage limit. Run `bin/prune-lambda-versions.sh <stage>` periodically (or after bulk deploys) to delete old versions, keeping the 3 most recent per function. The script skips any version that has provisioned concurrency configured to avoid disrupting live traffic.
