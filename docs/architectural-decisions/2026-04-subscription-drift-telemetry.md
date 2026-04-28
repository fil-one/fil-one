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
   dimension that is **binary** — exactly two values, `in_sync` and
   `out_of_sync`. Entity identifiers (`orgId`, `userId`) go in non-dimension
   fields so they appear in Loki log search, not in metric cardinality.
5. When the source scan can produce multiple rows per logical entity (e.g.
   several `SUBSCRIPTION` records for the same `orgId` after re-subscribes),
   the checker **dedupes by the logical entity id** before probing the
   source of truth. The first-seen row becomes the representative for
   logging. Without dedupe the job over-probes and over-counts drift.
6. Per run, emit one summary datapoint (no dimensions) with two counters:
   the count of entities classified as `out_of_sync` this run (e.g.
   `SubscriptionsNotInSync` for FIL-157), and the count of entities that
   could not be probed because the prerequisite state was not in place
   (e.g. `SubscriptionsMissingTenant` — active subs whose org has no
   `auroraTenantId` yet). Bookkeeping totals like `Scanned`,
   `UniqueEntities`, and `SkippedDuplicate` are deliberately omitted —
   they exist in the per-run log line for debugging but are not worth
   metric cardinality.
7. **Probe failures are not counted.** Transport errors talking to the source
   of truth produce a `console.error` line and skip the per-entity emission.
   A total outage therefore manifests as zero per-entity datapoints, which a
   Grafana **no-data alert on the per-entity metric** turns into a page.
   Lumping probe failures into a drift counter makes alerts trigger on
   outages instead of real drift; making them a separate counter just
   duplicates what no-data alerts already do.
8. No new infrastructure for delivery: the existing CloudWatch Metric Stream
   → Firehose → Grafana Cloud Prometheus pipeline (see
   `2026-03-observability-architecture.md`) already includes the `FilOne`
   namespace, so new `FilOne/*` metrics appear automatically.
