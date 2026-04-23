# ADR: Drift-Check Telemetry Pattern

**Status:** Accepted
**Date:** 2026-04-23

## Context

Stripe webhooks write subscription state to DynamoDB and then best-effort call
the Aurora backoffice API to sync tenant status. If the Aurora call fails, the
webhook still returns 200 (so Stripe does not retry) and DynamoDB drifts
silently from Aurora reality. The existing safety nets —
`grace-period-enforcer` and `usage-reporting-worker` — only react inside their
own narrow windows. We need a general way to _observe_ drift between our
internal state and an external source of truth, without coupling that
observation to any one remediation path.

FIL-157 is the first concrete instance (Aurora tenant status vs DynamoDB
`subscriptionStatus`). More will follow (e.g. Stripe payment-method state,
Aurora tenant setup completion), so the mechanism is generalised here.

## Decision

Use **scheduled read-only Lambdas** that emit **EMF metrics** classified by
drift outcome. Specifically:

1. One Lambda per coherent drift domain, under
   `packages/backend/src/jobs/`.
2. Scheduled via `sst.aws.CronV2` in `sst.config.ts`, frequency chosen to
   match the desired time-to-detect (12h for FIL-157).
3. The Lambda is **observe-only** — no writes to DynamoDB, no Aurora state
   changes. Remediation is a separate concern (e.g. FIL-156).
4. Per evaluated entity, emit one EMF datapoint with a `classification`
   dimension whose values include exactly one `in_sync` case and one or more
   `drift_*` cases. Keep the dimension set **low-cardinality** —
   entity identifiers (`orgId`, `userId`) go in non-dimension fields so they
   appear in Loki log search, not in metric cardinality.
5. When the source scan can produce multiple rows per logical entity (e.g.
   several `SUBSCRIPTION` records for the same `orgId` after re-subscribes),
   the checker **dedupes by the logical entity id** before probing the
   source of truth. The first-seen row becomes the representative for
   logging. Without dedupe the job over-probes and over-counts drift.
6. Per run, emit one summary datapoint (no dimensions) with counts at
   minimum for `Scanned` (raw rows), `UniqueEntities`, `SkippedDuplicate`,
   `SkippedNoTenant` (or equivalent unresolvable-row bucket), and
   `ProbeFailed`. Probe failures (transport errors talking to the source
   of truth) are _separate_ from drift — lumping them together would make
   alerts trigger on outages instead of on real drift.
7. No new infrastructure for delivery: the existing CloudWatch Metric Stream
   → Firehose → Grafana Cloud Prometheus pipeline (see
   `2026-03-observability-architecture.md`) already includes the `FilOne`
   namespace, so new `FilOne/*` metrics appear automatically.

## Drift-status rule of thumb

For each drift domain, enumerate _every_ possible downstream state and
assign it to exactly one `DriftStatus` value:

- `in_sync` — matches the expected state. Not counted as drift.
- `drift_<reason>` — a specific, actionable mismatch. Counted as drift and
  alerted on.
- `<legitimate reason>` — matches an alternative expected state that is
  _not_ a bug (e.g. `quota_locked` when scanning trials). Emitted on the
  `classification` EMF dimension but excluded from the drift alert.

When in doubt, carve out a new `drift_<reason>` rather than folding cases
into a generic `drift_other`, so the dashboard remains actionable.

## Consequences

- Fast to ship: new drift checks reuse the same pattern, metric namespace,
  and delivery pipeline. No CDK wiring beyond the Lambda + CronV2 pair.
- Alerts are bounded: low-cardinality dimensions keep Prometheus happy.
- Grafana dashboards live outside the repo, so the PR description is the
  load-bearing link between code and panel — reviewers must confirm it.
- Because the checker is strictly observe-only, adding one carries no risk
  to production write paths. This is deliberate — remediation and
  observation evolve independently.
