# ADR: GitHub Actions Telemetry via OpenTelemetry

**Status:** Accepted
**Date:** 2026-03-23

## Context

We want to visualize CI job durations and how they evolve over time in Grafana Cloud. The ideal data model is tracing: one span per job step, nested under jobs and workflow runs, exported to Tempo via OTLP. Grafana Cloud's OTLP ingest is HTTPS-only, which rules out gRPC-only tools.

## Decision

Use **`paper2/github-actions-opentelemetry`** (~80 stars, 683 commits, v0.10.0 February 2026).

It reconstructs traces post-hoc from the GitHub REST API and exports them via the OpenTelemetry SDK. It runs as a dedicated job triggered by `workflow_run: types: [completed]` or as a final step within the same workflow.

Key reasons:

- **Traces + metrics with zero infrastructure.** The only Action-based option that exports both signals natively. Metrics include `github.job.queued_duration`, which reveals runner pool starvation that traces alone cannot surface.
- **Standard `OTEL_*` configuration.** Point `OTEL_EXPORTER_OTLP_ENDPOINT` at the Grafana Cloud OTLP gateway and it works — no Grafana-specific setup.
- **Most active development.** 683 commits and a February 2026 release indicate strong ongoing maintenance despite a single maintainer.
- **Non-invasive.** Runs as a separate job after the workflow completes; does not modify the runtime environment of any build step.

## Options Considered

**`inception-health/otel-export-trace-action`** - gRPC-only, unmaintained since March 2023.

**`plengauer/opentelemetry-bash`** (~143 stars) — Injects OTel auto-instrumentation into the runtime environment of each job, producing per-command spans. Exports all three signals (traces, metrics, logs). Rejected because of runtime invasiveness — it modifies the shell environment of every step, which could interfere with build tooling — and the overhead it adds to billable runner minutes.

**`corentinmusard/otel-cicd-action`** (~62 stars) — Drop-in fork of the original `otel-export-trace-action` with HTTPS support added. Traces only, no metrics or logs. Rejected because the lack of native metrics means extra Grafana configuration to get time-series dashboards.

**Grafana CI OTel Collector + `githubactionsreceiver`** (~30 stars) — A standalone OTel Collector receiving GitHub webhook events. Real-time traces with zero runner cost, but requires deploying and exposing a collector instance to the internet. Rejected as overkill for starting out.

## Consequences

- A dedicated telemetry job consumes billable runner minutes on each workflow run.
- Traces appear minutes after workflow completion, not in real time.
- Step granularity is limited to what the GitHub API provides (start/end timestamps per step, no command-level depth).
- Single maintainer (paper2) — if the project is abandoned, `corentinmusard/otel-cicd-action` is a viable fallback for traces, or the Grafana CI OTel Collector for a more complete solution.
