# ADR: Set up the Aurora tenant synchronously on the first bucket or access key creation

**Status:** Accepted
**Created:** 2026-05-13
**Supersedes:** [2026-03-aurora-tenant-setup-workflow.md](2026-03-aurora-tenant-setup-workflow.md)

## Context

A new FilOne org needs a Service Orchestrator tenant, plus a tenant API key and an S3 access key, before it can do anything useful. Previously we kicked this off the first time a user signed in: the auth middleware enqueued an SQS FIFO message and a separate Lambda walked the state machine asynchronously. `GET /api/me` re-enqueued on every call as a self-healing fallback. The bucket and access-key endpoints returned **503 "try again later"** if setup wasn't finished yet.

We are about to onboard additional regions backed by different Service Orchestrators (see [Service Orchestrator Management API ADR](2026-04-service-orchestrator-management-api.md)). Each region's Service Orchestrator requires its own tenant. Most users will use exactly one region, so eagerly provisioning a tenant on **every** Service Orchestrator at sign-in time would create resources the user never touches. We want a model where each Service Orchestrator's tenant is created on demand — when the user actually places their first bucket or access key in that region.

A secondary motivation: the existing 503 "try again later" response is opaque to the user. They have no way to know when setup will finish or what to do when it stays stuck. Driving setup inline lets the user's request complete (or fail with a clear, actionable retry message) as one operation.

Aurora setup is fast in practice — typically around 1 second — well within an API Gateway request budget, so the synchronous move is feasible without timing-out user requests.

## Decision

**Defer Aurora tenant setup until the user takes a real action.** The first `POST /api/buckets` or `POST /api/access-keys` for a fresh org drives the entire setup synchronously inside the request, then completes the original operation. The user's request returns 201 when (and only when) the tenant is ready and the bucket/key has been created.

If setup fails (transient Aurora outage, polling budget exhausted, lost SSM secret, etc.), the handler returns **503 "We're still setting up your account. Please try again in a moment."** and the user retries. Each retry resumes the state machine from whatever step is next.

A new `ensureTenantReady` wrapper lives in `packages/backend/src/lib/aurora-tenant-setup.ts`. It calls `processTenantSetup` and returns the `auroraTenantId` on success or throws on any failure — the handler doesn't need to understand setup status values.

The sign-in path (`middleware/auth.ts`) and `GET /api/me` no longer trigger setup. The org profile is still created with `setupStatus: FILONE_ORG_CREATED` at sign-in; the rest happens later, lazily.

### Stuck-tenant alert

Each thrown failure increments a per-org `setupFailureCount` (atomic DynamoDB `ADD`). When the count first crosses 3, the failing invocation does a one-time `Scan` of `UserInfoTable` for org profiles where `setupFailureCount >= 3 AND setupStatus != AURORA_S3_ACCESS_KEY_CREATED` and emits a `StuckAuroraTenantSetupCount` EMF gauge. When a setup eventually succeeds, the conditional `UpdateItem` that writes the terminal `setupStatus` uses `ReturnValues: 'ALL_OLD'` to read the prior `setupFailureCount`; if that prior value was `≥ 3`, the invocation re-emits the gauge so the alert clears immediately. The counter itself is **not** reset — it stays on the row as a monotonic record of failed attempts before setup completed. The gauge's `setupStatus <> :complete` filter excludes terminal-status rows, so the carried-over counter does not contribute to the gauge. The Grafana alert fires on `> 0` and auto-clears when the gauge drops back to zero.

The convention "an org is currently failing iff `setupFailureCount >= N AND setupStatus <> AURORA_S3_ACCESS_KEY_CREATED`" is the contract for any future predicate that wants to detect ongoing failure — the `setupStatus` qualifier is required because `setupFailureCount` alone is ambiguous after success.

Operators triage by Loki log search on `orgId` — failure details are in `console.error` lines from `ensureTenantReady` and the underlying Aurora API libraries. No error column in DynamoDB.

### Setup-duration metric

A single `AuroraTenantSetupDuration` EMF metric (Milliseconds) is emitted once per org over its lifetime. The Lambda invocation that first wins the `FILONE_ORG_CREATED → AURORA_TENANT_CREATED` transition wraps its `runSetup` call in a measure-and-emit helper. Successful completion emits the real wall-clock; a polling-budget exhaustion emits the budget value (≈7.8 s today). Subsequent retries from later requests don't re-emit.

## Concurrency under synchronous invocation

Dropping SQS removes two guarantees: per-org dedup (`MessageDeduplicationId: orgId`) and per-org serialization (`MessageGroupId: orgId`). Two concurrent requests for the same org — a double-clicked "Create bucket", or back-to-back create-bucket / create-access-key — can now both land in `processTenantSetup` simultaneously. Aurora setup must be correct under that concurrency without leaning on SQS.

`processTenantSetup` in `packages/backend/src/lib/aurora-tenant-setup.ts` is a state machine driven by `setupStatus` in `UserInfoTable[pk=ORG#<id>, sk=PROFILE]`. Each invocation reads the current status, performs the next external mutation, then writes a conditional `UpdateItem` that advances the status by one notch:

```
undefined / FILONE_ORG_CREATED
   → createTenant → runSetup → createAndStoreApiKey → createAndStoreS3AccessKey
AURORA_TENANT_CREATED
   → runSetup → createAndStoreApiKey → createAndStoreS3AccessKey
AURORA_TENANT_SETUP_COMPLETE
   → createAndStoreApiKey → createAndStoreS3AccessKey
AURORA_TENANT_API_KEY_CREATED
   → createAndStoreS3AccessKey
AURORA_S3_ACCESS_KEY_CREATED
   → no-op
```

### Concurrency hazards addressed

- **Race-loser on `createTenantToken`.** Aurora's 409 on duplicate token name prevents leaking a token, but the prior code surfaced it as an uncaught 500.
- **Lost secret on mid-flight crash in `createAndStoreApiKey`.** If a prior attempt got past `createTenantToken` (201) but crashed before `PutParameter`, the token is gone — Aurora only returns it once. Every subsequent attempt sees 409 and the chain stays stuck.
- **Check-then-act on SSM in `createAndStoreS3AccessKey` recovery.** A concurrent winner milliseconds away from writing SSM looks like "secret lost" to the loser, surfacing a false-positive critical error.
- **Uncaught `ConditionalCheckFailedException`.** Every concurrent loser at a status-advance write became a 500 instead of "another invocation already did this, continue or return".
- **Stale reads from eventually-consistent `GetItemCommand`** widen every race window from "truly simultaneous" to "within a few hundred ms".
- **`runSetup` tail latency.** Aurora's per-component setup is asynchronous; a single POST may return mid-progress with `lastSetupStep !== 'FINISHED'`.

### Hardening introduced by this ADR

- **Strong-consistent entry read.** `processTenantSetup` issues `GetItemCommand` with `ConsistentRead: true`, so an invocation doesn't re-run a step a prior invocation finished milliseconds ago.
- **Race-tolerant status advances.** An `advanceStatus` helper wraps every conditional `UpdateItemCommand`, catches `ConditionalCheckFailedException`, and returns `'already-advanced'`. `createTenant` re-reads strong-consistently on that signal to fetch the winner's `auroraTenantId`; the other three sites continue or return.
- **Typed duplicate-name error for the backoffice API.** `DuplicateTokenNameError` is exported from `aurora-backoffice.ts` (symmetric to `DuplicateKeyNameError` in `aurora-portal.ts`), so credential creators can recognise 409s explicitly.
- **Bounded SSM poll on duplicate name.** Both credential creators poll SSM on the `[20, 50, 100, 250, 500] ms` schedule (~920 ms total) before declaring the secret truly lost. This absorbs the narrow concurrent-healthy race window without dragging out the genuinely-lost case.
- **Inline `runSetup` polling.** `setupAuroraTenant` is retried on a `[100, 200, 500, 1000, 2000, 4000] ms` schedule (7 attempts, ~7.8 s of waits) until `lastSetupStep === 'FINISHED'`. The everyday case finishes in a single round-trip; the rare tail still fits within the API Gateway request budget.

### No single-flight guard

Under the hardening above every step is independently safe. Concurrent invocations become a waste-of-work problem (duplicated Aurora calls, deduped by 409s) rather than a correctness problem. We considered three options for the truly-lost-secret corner case: don't-auto-recover (loud fail), delete-then-recreate, and a single-flight scoped to the recovery path only. Delete-then-recreate is unsafe under three-way races — a slow healthy winner can be misclassified and have its still-valid Aurora resource deleted after the winner's SSM write has begun. A scoped single-flight reintroduces the guard we're avoiding. We chose loud-fail: a confirmed lost secret throws a typed duplicate-name error that flows to operator alerting. Revisiting this with a DDB-backed single-flight guard with TTL is tracked as follow-up [FIL-334](https://linear.app/filecoin-foundation/issue/FIL-334/wrap-setup-aurora-tenant-with-a-ddb-guard-with-ttl).

### Residual risks accepted

- A Lambda crash in the ~100 ms window between Aurora 201 and SSM `PutParameter` leaves an orphan credential in Aurora. Subsequent attempts surface a clear typed error requiring operator action. Rare, visible, non-corrupting.
- Concurrent invocations duplicate Aurora API call volume per step. Aurora dedupes via 409. Cost is bandwidth and rate-limit headroom, not correctness.
- A `runSetup` >7.8 s tail returns 503 to the user; client retry resumes from whatever status was reached.

## Consequences

### Positive

- **No wasted Aurora provisioning.** Tenants are created only when users actually use the product.
- **Clearer failure surface.** When setup fails the user is told what to do (retry); they aren't left wondering whether the system is slow or broken.
- **Direct alerting.** `StuckAuroraTenantSetupCount` rises immediately and clears automatically without a cron heartbeat.
- **Visible latency.** `AuroraTenantSetupDuration` gives us a real wall-clock distribution. Timeouts cluster at the poll-budget value, making p99 regressions easy to spot.
- **Operationally simpler.** No async retry budget to tune; the user is the retry mechanism.

### Negative

- **Slower first POST.** The first bucket/access-key request blocks on Aurora setup (usually around one second, up to the poll budget on the tail). Provisioned concurrency is already in place for these handlers, mitigating Lambda cold start on top of this.
- **No automatic retry.** A flapping Aurora dependency now surfaces as a 503 the user must retry, instead of being absorbed silently by SQS retries.
- **Manual-fix gap on the stuck-tenant gauge.** If an operator fixes the underlying issue without the user retrying, the gauge doesn't auto-clear. Tracked as a follow-up ticket (operator-facing endpoint to re-emit).

## Migration

The existing SQS queue, DLQ, and consumer Lambda are **kept in place** for one release cycle to drain any in-flight messages. After the queue and DLQ have been at zero for a sustained window, the infrastructure and consumer code are removed per [docs/2026-05-13-sqs-tenant-setup-removal.md](../2026-05-13-sqs-tenant-setup-removal.md).

## References

- Predecessor: [2026-03-aurora-tenant-setup-workflow.md](2026-03-aurora-tenant-setup-workflow.md) (superseded)
- Observability: [2026-03-observability-architecture.md](2026-03-observability-architecture.md)
- Runbook: [Cannot Complete Aurora Tenant Setup](https://www.notion.so/filecoin/FilOne-On-Call-RunBook-3427631f282580a988ddedb0a208f534?source=copy_link#3647631f28258018b4dbdff166df4a4b)
