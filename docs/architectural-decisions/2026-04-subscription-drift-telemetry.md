# ADR: Drift-Check Telemetry Pattern

**Status:** Accepted
**Date:** 2026-04-23

## Context

Stripe webhooks write to DynamoDB and then best-effort call the Aurora
backoffice API to sync tenant status. If the Aurora call fails, the webhook
still returns 200 and DynamoDB drifts silently from Aurora reality. We need a
general way to _observe_ such drift, decoupled from any specific remediation
path.

## Decision

A scheduled read-only Lambda per drift domain, under
`packages/backend/src/jobs/`, scheduled with `sst.aws.CronV2` at a frequency
matching the desired time-to-detect (12h for FIL-157). The Lambda only
observes — remediation is a separate concern.

**Per-run summary metric, not per-entity datapoints.** One EMF datapoint
per invocation (no dimensions) with three counters:

- `<Domain>NotInSync` — entities whose source-of-truth state disagrees with
  ours. The primary drift signal.
- `<Domain>MissingTenant` — entities that could not be probed because
  prerequisite state isn't in place yet (e.g. active sub whose org has no
  `auroraTenantId`).
- `<Domain>ProbeFailed` — entities where the source-of-truth call errored.
  When `ProbeFailed > 0`, `NotInSync` is an under-count.

Per-entity EMF datapoints are deliberately avoided — entity counts are
unbounded and would blow up Grafana Cloud cardinality.

**Structured logs for triage.** Each out-of-sync entity emits one log line
(e.g. `[subscription-drift-checker] out_of_sync` with `orgId`, `userId`,
`auroraTenantId`, observed source-of-truth status). On-call queries Loki for
these lines after a `NotInSync > 0` alert to enumerate affected entities.

**Dedupe by logical entity id before probing.** When the source scan can
produce multiple rows per entity (e.g. several `SUBSCRIPTION` records for
the same `orgId` after re-subscribes), keep the first-seen row as the
representative. Without dedupe a single drifted entity inflates the counter
N-fold and produces N duplicate log lines.

**Alerting.** `NotInSync > 0` pages on-call. `ProbeFailed > 0` (sustained
above a threshold) catches source-of-truth outages — necessary because a
chronically-failing probe on a genuinely-drifted entity would otherwise
never alert.

**Delivery.** No new infrastructure: the existing CloudWatch Metric Stream
→ Firehose → Grafana Cloud pipeline (see
`2026-03-observability-architecture.md`) already covers the `FilOne`
namespace, and structured logs reach Loki via the project's standard
log-shipping path.
