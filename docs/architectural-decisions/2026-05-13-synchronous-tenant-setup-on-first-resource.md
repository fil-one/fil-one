# ADR: Set up the Aurora tenant synchronously on the first bucket or access key creation

**Status:** Accepted
**Created:** 2026-05-13
**Supersedes:** [2026-03-aurora-tenant-setup-workflow.md](2026-03-aurora-tenant-setup-workflow.md)

## Context

A new FilOne org needs a Service Orchestrator tenant, plus a tenant API key and an S3 access key, before it can do anything useful. Previously we kicked this off the first time a user signed in: the auth middleware enqueued an SQS FIFO message and a separate Lambda walked the state machine asynchronously. `GET /api/me` re-enqueued on every call as a self-healing fallback. The bucket and access-key endpoints returned **503 "try again later"** if setup wasn't finished yet.

We are about to onboard additional regions backed by different Service Orchestrators (see [Service Orchestrator Management API ADR](2026-04-service-orchestrator-management-api.md)). Each region's Service Orchestrator requires its own tenant. Most users will use exactly one region, so eagerly provisioning a tenant on **every** Service Orchestrator at sign-in time would create resources the user never touches. We want a model where each Service Orchestrator's tenant is created on demand — when the user actually places their first bucket or access key in that region.

A secondary motivation: the existing 503 "try again later" response is opaque to the user. They have no way to know when setup will finish or what to do when it stays stuck. Driving setup inline lets the user's request complete (or fail with a clear, actionable retry message) as one operation.

Aurora setup is fast in practice — typical <1 s, p99 <10 s ([2026-05-12-tenant-setup-analysis.md](../2026-05-12-tenant-setup-analysis.md)) — well within an API Gateway request budget, so the synchronous move is feasible without timing-out user requests.

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

## Consequences

### Positive

- **No wasted Aurora provisioning.** Tenants are created only when users actually use the product.
- **Clearer failure surface.** When setup fails the user is told what to do (retry); they aren't left wondering whether the system is slow or broken.
- **Direct alerting.** `StuckAuroraTenantSetupCount` rises immediately and clears automatically without a cron heartbeat.
- **Visible latency.** `AuroraTenantSetupDuration` gives us a real wall-clock distribution. Timeouts cluster at the poll-budget value, making p99 regressions easy to spot.
- **Operationally simpler.** No async retry budget to tune; the user is the retry mechanism.

### Negative

- **Slower first POST.** The first bucket/access-key request blocks on Aurora setup (around one second typical, up to the poll budget on the tail). Provisioned concurrency is already in place for these handlers, mitigating Lambda cold start on top of this.
- **No automatic retry.** A flapping Aurora dependency now surfaces as a 503 the user must retry, instead of being absorbed silently by SQS retries.
- **Manual-fix gap on the stuck-tenant gauge.** If an operator fixes the underlying issue without the user retrying, the gauge doesn't auto-clear. Tracked as a follow-up ticket (operator-facing endpoint to re-emit).

## Migration

The existing SQS queue, DLQ, and consumer Lambda are **kept in place** for one release cycle to drain any in-flight messages. After the queue and DLQ have been at zero for a sustained window, the infrastructure and consumer code are removed per [docs/2026-05-13-sqs-tenant-setup-removal.md](../2026-05-13-sqs-tenant-setup-removal.md).

## References

- Predecessor: [2026-03-aurora-tenant-setup-workflow.md](2026-03-aurora-tenant-setup-workflow.md) (superseded)
- Concurrency analysis: [2026-05-12-tenant-setup-analysis.md](../2026-05-12-tenant-setup-analysis.md)
- Observability: [2026-03-observability-architecture.md](2026-03-observability-architecture.md)
- Runbook: [docs/runbooks/stuck-aurora-tenant-setup.md](../runbooks/stuck-aurora-tenant-setup.md)
- Test plan: [2026-05-13-tenant-setup-rework-test-plan.md](../2026-05-13-tenant-setup-rework-test-plan.md)
