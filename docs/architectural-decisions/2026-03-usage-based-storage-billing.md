# ADR: Usage-Based Storage Billing via Stripe Billing Meters

**Status:** Accepted
**Date:** 2026-03-10

## Context

Customers are billed for storage at $4.99/TiB/month. This ADR describes the automated pipeline that queries actual storage from the Aurora Backoffice API (the source of truth), computes the period average, and reports it to Stripe via Billing Meters. The `tenantId` maps to `orgId` stored in BillingTable.

## Options Considered

**Stripe meter `sum` aggregation** — Rejected; possibility of daily reports of a running average accumulate incorrectly or possible gaps in reporting if a worker fails.

**Single Lambda for all tenants** — Rejected; risks the 15-minute timeout and couples all tenants to a single failure domain.

**SQS queue with workers** — Deferred; direct async Lambda invocation is simpler and sufficient at current scale.

## Decision

Use a **Stripe Billing Meter** with `last_during_period` aggregation and an **orchestrator/worker fan-out** triggered daily by EventBridge.

```
EventBridge (cron: daily at 06:00 UTC)
  -> Orchestrator Lambda (packages/backend/src/jobs/usage-reporting-orchestrator.ts)
       -> scans BillingTable (paginated) for all non-canceled subscriptions
       -> reads orgId directly from each BillingTable record
       -> deduplicates by orgId (skips duplicate orgs from multiple subscription records)
       -> async-invokes Worker Lambda per unique org
  -> Worker Lambda (packages/backend/src/jobs/usage-reporting-worker.ts)
       -> queries Aurora Backoffice API via getStorageSamples() (1h window, from currentPeriodStart to now)
       -> computes average TiB over the billing period
       -> reports meter event to Stripe Meter API
       -> writes audit record to BillingTable (pk: ORG#<orgId>, sk: USAGE_REPORT#<reportDate>, 90-day TTL)
```

The worker computes a running average from `current_period_start` to now. Because `last_during_period` always takes the most recent value, the final report before invoice generation reflects the full-period average — reporting the same day twice is harmless.

## Consequences

- Customers are billed for actual average storage usage rather than a point-in-time snapshot.
- Fan-out with orchestrator dedup by `orgId` isolates tenant processing and ensures each org is processed exactly once, regardless of subscription record count.
- `last_during_period` eliminates application-level idempotency logic.
- Daily audit records (`ORG#<orgId>/USAGE_REPORT#<date>`) provide a trail of what was reported to Stripe.
- Aurora Backoffice API becomes a critical billing dependency
- At scale, per-worker Stripe calls could approach rate limits
- Adds 2 Lambdas, 1 EventBridge rule, and SST secrets to the operational surface.
