# ADR-001: Observability Architecture for Serverless Wide Events

**Status:** Accepted (revised 2026-03-18)
**Date:** 2026-03-17

---

## Context

We are building the management console for an S3-compatible object storage
product. The console runs on AWS Lambda and handles operations such as bucket
creation and deletion, access key management, object uploads and downloads, and
usage/billing queries. We need production observability that supports the "wide
event" pattern — emitting a single, context-rich structured event per request per
service, with many high-cardinality fields (account IDs, access key IDs, bucket
names, object keys, request IDs, feature flags, storage tier metadata, etc.).
This enables debugging through structured queries rather than grep-based log
archaeology.

Our constraints are:

- **AWS Lambda** is our primary compute platform.
- **OpenTelemetry (OTel)** is our instrumentation standard — we want vendor-neutral telemetry.
- **Grafana** is our visualization and alerting layer (Grafana Cloud).

We need an architecture that carries rich, high-cardinality event data from
Lambda functions to a queryable backend, with reasonable cost, latency, and
operational overhead.

### What we tried first

Our initial implementation (commits 2d1706d–7c3dcb7) used **two Lambda layers**:
the upstream OTel Collector Extension (`opentelemetry-collector-amd64`) running a
sidecar collector process, plus the OTel Node.js auto-instrumentation layer
(`opentelemetry-nodejs`) wrapping handlers via `AWS_LAMBDA_EXEC_WRAPPER`. We
maintained custom collector configs (`otel/collector-async.yaml` and
`otel/collector-sync.yaml`) with `decouple` processor for async flush, a logger
built on `@opentelemetry/api-logs`, and Secrets Manager integration for Grafana
Cloud credentials.

**This approach had two serious problems:**

- **Excessive cold start overhead.** The two layers combined added **~1000ms to
  every cold start**. For API route handlers where p99 latency matters, this
  made cold starts visibly slow.
- **Severely delayed telemetry from infrequent SQS handlers.** The `decouple`
  processor defers telemetry export to the next invocation. For SQS handlers
  invoked infrequently (e.g. tenant setup), the next invocation may not come for
  hours or days — telemetry sat in the collector's buffer, making it impossible
  to observe events in semi-realtime. We maintained a separate
  `collector-sync.yaml` without `decouple` for these handlers, but this added
  operational complexity and was easy to misconfigure.

---

## Decision

**Lambda → Manual OTel SDK → direct OTLP HTTP export to Grafana Cloud Tempo**
for traces, plus **Lambda → CloudWatch Logs → Kinesis Firehose → Grafana Cloud
Loki** for logs (with a short-retention copy kept in CloudWatch for operational
access). Metrics are auto-derived from spans via Tempo's metrics-generator.

### How it works

1. **Manual SDK initialization.** Each Lambda function initializes an OTel
   `TracerProvider` with `BatchSpanProcessor` and `OTLPTraceExporter` at module
   load (cold start). No Lambda layers, no sidecar collector process, no
   auto-instrumentation wrapper. The application code imports
   `@opentelemetry/sdk-trace-base` and `@opentelemetry/exporter-trace-otlp-http`
   directly.

2. **Wide events as span attributes.** Same as before — all wide-event context
   (account metadata, bucket configuration, access key scope, storage tier,
   feature flags, error details) is attached as attributes on OTel spans. OTel
   span attributes have no practical cardinality limits, and all are queryable
   via TraceQL in Tempo.

3. **Synchronous flush via `forceFlush()`.** Before the Lambda handler returns,
   it calls `provider.forceFlush()` to send a single OTLP HTTP POST to Grafana
   Cloud. This adds ~30–100ms per invocation (30–80ms on warm invocations with
   keep-alive, up to 100ms on cold starts due to TLS handshake). This is a
   tradeoff: we accept a small per-invocation cost to eliminate the ~1000ms
   cold start overhead from Lambda layers.

4. **Plain console.log for application logs.** Application logs use plain
   `console.log`/`warn`/`error` — no structured logging library needed. The
   Lambda runtime's JSON log format (`AWS_LAMBDA_LOG_FORMAT=JSON`) wraps each
   call with `timestamp`, `level`, and `requestId` automatically. Logs go to
   stdout → CloudWatch Logs → Firehose → Grafana Cloud Loki. All structured
   queryable data lives in Tempo span attributes, not in log fields.

5. **Log delivery via Firehose with CloudWatch retention.** Logs are written to
   CloudWatch Logs at standard ingestion ($0.50/GB) and kept with a short
   retention period (e.g. 7 days) for quick operational access via the AWS
   console. A Firehose subscription filter forwards the same logs to Grafana
   Cloud Loki for long-term storage and LogQL querying.

6. **Signal routing.**
   - **Traces → Tempo** — wide-event spans with all business context as
     attributes, queryable via TraceQL. This is the primary query surface for
     debugging and analytics.
   - **Logs → Loki** — plain-text application logs with Lambda-injected
     `requestId` for correlation with traces. Low-cardinality Loki labels
     (service, environment, log level).
   - **Metrics → Mimir** — RED metrics (rate, errors, duration) auto-derived
     from spans via Tempo's metrics-generator. No separate metrics SDK needed
     at current scale.

7. **Log-trace correlation via `requestId`.** Each span carries
   `faas.invocation_id` set to `context.awsRequestId`. Tempo's
   `tracesToLogsV2` configuration generates a Loki query filtered by
   `requestId`, enabling one-click navigation from a trace to all logs for
   that invocation. The reverse direction (logs → trace) requires a manual
   TraceQL query (`{ span.faas.invocation_id = "<requestId>" }`), which is
   acceptable — the primary debugging flow is trace-first, with logs as
   supporting detail.

8. **Sampling.** Head-based sampling is configurable via
   `OTEL_TRACES_SAMPLER`. At current scale (~300K requests/month), we send 100%
   of traces — well within Grafana Cloud's free tier. Tempo's metrics-generator
   derives unbiased RED metrics from all traffic. Tail-based sampling (keep all
   errors, sample successes at lower rate) can be added later via a gateway
   collector without changing Lambda instrumentation.

### Attribute enrichment pattern

A Middy middleware (`tracingMiddleware`) creates the root span per invocation and
stores the span reference on the Middy request so downstream middleware can add
custom attributes:

- The auth middleware enriches the span with `filone.user_id` and
  `filone.org_id` after successful authentication.
- The error handler middleware records caught exceptions on the span via
  `span.recordException(error)` and sets span status to ERROR. Exception events
  include `exception.type`, `exception.message`, and `exception.stacktrace` —
  all queryable via TraceQL.

Non-API Lambda functions (SQS subscribers, cron jobs) initialize the same
TracerProvider and create root spans manually, but do not use the HTTP-specific
`tracingMiddleware`.

### Lambda environment variables

```
# OTel SDK configuration
OTEL_SERVICE_NAME=filone-<stage>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<stage>,service.namespace=filone

# Grafana Cloud OTLP endpoint (used by OTLPTraceExporter)
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-us-central-0.grafana.net/otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(instanceId:apiKey)>

# Lambda runtime log formatting (adds requestId, timestamp, level to stdout)
AWS_LAMBDA_LOG_FORMAT=JSON
```

---

## Alternatives Considered

| Approach                      | Cold start           | Wide events                    | Ops overhead                    | Verdict                   |
| ----------------------------- | -------------------- | ------------------------------ | ------------------------------- | ------------------------- |
| **A. OTel Lambda Layers**     | ~1000ms (two layers) | Full (span attrs)              | High (collector YAML, decouple) | Implemented then replaced |
| **Chosen: Manual OTel SDK**   | ~30–80ms             | Full (span attrs)              | Low (no sidecar)                | Accepted                  |
| **B. ADOT Lambda Layers**     | 200ms–4s             | Full (span attrs)              | High (same as A)                | Rejected                  |
| **C. Grafana OTel Extension** | 100–300ms + layer    | Full (span attrs)              | Medium (pre-configured)         | Rejected                  |
| **D. Firehose → Tempo**       | N/A                  | N/A — protocol mismatch        | High (translation layer)        | Rejected                  |
| **E. JSON logs → Loki**       | Near-zero            | Limited (scan-based)           | Low                             | Rejected                  |
| **F. X-Ray + CloudWatch**     | Low (~50–100ms)      | 50 annotations, 64KB limit     | Low                             | Rejected                  |
| **G. Powertools (X-Ray)**     | Lowest (~50–100ms)   | 50 annotations, 64KB limit     | Lowest                          | Rejected                  |
| **H. EMF + X-Ray + CW**       | <5ms                 | Split across services          | Zero                            | Rejected                  |
| **I. CW OTLP endpoints**      | Low                  | 50 annotations (X-Ray backend) | Low                             | Rejected                  |
| **J. OTel → ClickHouse**      | Same as chosen       | Best (columnar)                | High (self-managed cluster)     | Deferred                  |

### Alternative A: OTel Lambda Extension Layers (initially implemented, then replaced)

Use two Lambda layers — the upstream OTel Collector Extension running a sidecar
collector process, plus the OTel Node.js auto-instrumentation layer wrapping
handlers via `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-handler`.

**We implemented this approach (commits 2d1706d–7c3dcb7) and rejected it after
deployment:**

- **Excessive cold start overhead.** The two layers combined added ~1000ms to
  cold starts. For API handlers where p99 latency matters, this was
  unacceptable.
- **Severely delayed telemetry from infrequent SQS handlers.** The `decouple`
  processor defers export to the next invocation — for handlers invoked
  infrequently (e.g. tenant setup), telemetry sat in the collector's buffer for
  hours or days, making semi-realtime observability impossible. A separate
  `collector-sync.yaml` config without `decouple` mitigated this but was easy
  to misconfigure.
- **Operational complexity.** Custom collector configs with `decouple`
  processor, `basicauth` extension, Secrets Manager lookups, and `telemetryapi`
  receiver configuration added significant surface area to debug when telemetry
  wasn't arriving.
- **Log pipeline coupling.** Application logs via `@opentelemetry/api-logs`
  required the collector extension to receive and forward log records. If the
  collector process failed, both traces and logs were lost.

The manual OTel SDK approach eliminates all of these problems: ~30–80ms cold
start (vs ~1000ms), synchronous flush guarantees telemetry delivery regardless
of invocation frequency, no sidecar process to configure, and logs flow
independently via stdout → CloudWatch → Firehose.

### Alternative B: ADOT Lambda Layers

AWS's own distribution of the OTel Lambda layer (ADOT) with Application Signals.

**Why we rejected it:**

- **Even worse cold starts.** ADOT layers add 200–500ms for newer versions, and
  500ms–4s for legacy collector-based versions. AWS labels the legacy
  collector-based approach "not recommended."
- **No advantage for Grafana Cloud export.** Exporting to non-CloudWatch
  endpoints (like Grafana Cloud OTLP) still requires the legacy layer with
  embedded collector — the newer Application Signals approach only supports
  CloudWatch/X-Ray destinations.

### Alternative C: Grafana's OTel Collector Lambda Extension

Grafana provides a pre-configured distribution of the OTel Collector Lambda
Extension optimized for Grafana Cloud. It uses the `decouple` processor for
async flush and stores API keys in AWS Secrets Manager.

**Why we rejected it:**

- **Same cold start problem.** Still carries 100–300ms cold start overhead from
  the collector extension process — less than the two-layer setup we tried, but
  still significant. Combined with the auto-instrumentation layer, total cold
  start overhead approaches what we measured.
- **Same decouple problem.** Async flush via `decouple` causes the same delayed
  telemetry issue for infrequently-invoked handlers.
- **Grafana Alloy is not an alternative for Lambda.** Grafana Alloy is designed
  for persistent processes and does not run as a Lambda extension. Grafana
  recommends deploying Alloy on EC2/ECS as a gateway collector — adding
  infrastructure we want to avoid.

### Alternative D: Lambda → Kinesis Firehose → Grafana Tempo

Route wide events through Kinesis Data Firehose using its HTTP endpoint
destination to push trace data to Tempo.

**Why we rejected it:**

- **Protocol mismatch.** Grafana Cloud built a Firehose-compatible endpoint
  (`aws-logs/api/v1/push`), but it only accepts **logs destined for Loki**, not
  traces for Tempo. Tempo ingests exclusively via OTLP (gRPC/HTTP), Jaeger, or
  Zipkin protocols.
- **No Firehose-to-OTLP path.** Firehose uses a proprietary JSON envelope
  format with custom headers (`X-Amz-Firehose-Protocol-Version`,
  `X-Amz-Firehose-Request-Id`) and authenticates via `X-Amz-Firehose-Access-Key`.
  Tempo expects standard `Authorization` headers. There is no built-in
  transformation — a translation layer (OTel Collector fleet or API Gateway +
  Lambda) is required.
- **Latency.** Firehose buffers with a minimum 60-second delivery interval.
  Wide events would arrive at Tempo with at least a one-minute delay.
- **X-Ray does not export to Firehose.** X-Ray has its own data store and API
  with no Firehose pipeline, so this approach cannot leverage existing tracing.
- **Double cost.** Firehose ingestion per GB, plus translation compute, plus
  Tempo ingestion — when direct OTLP export eliminates the first two.

Note: Firehose is excellent for _logs_ — we use it for the Lambda → CloudWatch →
Firehose → Loki pipeline. The rejection applies only to using Firehose for trace
data.

### Alternative E: Lambda → Wide-event JSON logs → Grafana Loki

Emit wide events as structured JSON log lines and store them directly in Loki.

**Why we rejected it:**

- **Cardinality explosion.** Loki indexes by low-cardinality labels. Using
  high-cardinality wide-event fields as labels creates massive index bloat.
  Loki defaults to a limit of 15 index labels.
- **Structured metadata is scan-based.** Loki's structured metadata feature can
  store high-cardinality fields without indexing them, but querying them is a
  brute-force scan, not an index lookup. Broad analytical queries over large
  time ranges become slow.
- **No columnar query model.** LogQL parses JSON from each matching log line at
  query time — fundamentally different from Tempo's columnar storage where each
  attribute is queryable directly. Aggregation queries are significantly slower.
- **Log volume cost.** A 50-field wide event at ~1–2KB per request becomes
  expensive at scale on Grafana Cloud's per-GB Loki pricing. Tempo's storage
  model is more efficient for structured span data.

### Alternative F: X-Ray traces + CloudWatch logs, queried from Grafana

Use X-Ray for traces and CloudWatch for logs, with Grafana querying both
in-place via data source plugins — no data movement required.

**Why we rejected it:**

- **Wide event support is constrained.** X-Ray supports up to 50 annotations
  per trace (indexed, searchable), with a 64KB segment document limit. Metadata
  accepts any JSON but is not indexed or searchable — only viewable on the full
  trace. Insufficient for the wide-event pattern.
- **One-directional log-trace correlation.** Lambda sets `_X_AMZN_TRACE_ID` on
  every invocation and logs can link to X-Ray traces, but the X-Ray data source
  does not natively support trace-to-logs navigation. No bidirectional
  correlation like Tempo ↔ Loki.
- **Sluggish query performance.** CloudWatch Logs Insights queries take 5–30+
  seconds for large datasets; X-Ray trace queries take 1–5 seconds. Noticeably
  slower than sub-second responses from pre-stored Loki/Tempo data, especially
  during interactive debugging sessions.
- **X-Ray SDK deprecation.** AWS announced X-Ray SDKs enter maintenance mode
  February 2026, with end-of-support February 2027. AWS now recommends
  migrating to OTel/ADOT. Risky for a new project.
- **X-Ray and OTel use different propagation headers.** X-Ray propagates via
  `X-Amzn-Trace-Id` in a proprietary format; OTel uses W3C `traceparent`. If
  we later migrate some functions to OTel, trace context is lost at the
  boundary — disconnected traces instead of one connected graph. Choosing OTel
  from the start avoids this migration hazard.

### Alternative G: Powertools for AWS Lambda (X-Ray + CloudWatch)

Use `@aws-lambda-powertools/tracer` + `@aws-lambda-powertools/logger` for the
simplest setup with the lowest cold start overhead of any trace-capable option.

**Advantages:**

- **Lowest cold start overhead (~50–100ms).** AWS explicitly states Powertools
  Tracer "relies on AWS X-Ray SDK over OpenTelemetry Distro (ADOT) for optimal
  cold start."
- **Excellent developer ergonomics.** `appendPersistentKeys()` enables
  progressive context enrichment through middleware — exactly the pattern we
  want for wide events on log lines.
- **Zero infrastructure.** No collector, no extension, no Firehose. Just npm
  packages and an X-Ray active tracing flag.

**Why we rejected it:**

- **Same X-Ray limitations as Alternative F** — 50-annotation limit, 64KB
  segment size, one-directional correlation, deprecation timeline.
- **Log enrichment ≠ trace enrichment.** `appendPersistentKeys()` enriches
  _log lines_, not trace spans. The Tracer's `putAnnotation()` (50 indexed) and
  `putMetadata()` (not indexed) are far more limited than OTel span attributes.
- **No tail sampling path.** X-Ray supports head-based sampling only. The only
  cost control lever discards errors and successes at the same rate.
- **Error capture is split across services.** X-Ray tells you _which requests
  failed_ (fault/error/throttle status); CloudWatch Logs tells you _why_ (full
  stack traces, context). With the chosen approach, TraceQL answers both in a
  single query via `span.recordException()` events.

### Alternative H: All-native AWS (EMF + X-Ray + CloudWatch)

Use CloudWatch Embedded Metric Format for metrics, X-Ray for traces, and
CloudWatch Logs for structured events, with Grafana querying via data source
plugins. No data movement, no pipeline infrastructure.

**Advantages:**

- **Near-zero cold start overhead (<5ms).** EMF writes JSON to stdout (no
  network calls), X-Ray is handled by the Lambda platform, CloudWatch Logs is
  built-in. Orders of magnitude better than any OTel approach.
- **Zero infrastructure.** No pipeline, no data movement, no external services
  to manage.

**Why we rejected it:**

- **Severe query-time limitations.** CloudWatch Logs Insights takes 5–30+
  seconds for large datasets. X-Ray queries take 1–5 seconds. This lag
  compounds during interactive debugging sessions with iterative exploration.
- **EMF cardinality trap.** Every distinct dimension value creates a new
  CloudWatch Metric time series. High-cardinality values (userId, requestId) as
  dimensions generate massive custom metric counts and huge CloudWatch costs.
  Must use `setProperty()` for high-cardinality context (searchable in Logs
  Insights only, no metrics).
- **Split wide-event data.** Traces in X-Ray and logs in CloudWatch cannot be
  queried in one place. No unified wide-event-per-request view.
- **Vendor lock-in.** Instrumentation uses AWS-specific APIs rather than OTel,
  violating our vendor-neutrality constraint.
- **Loses Grafana Cloud features.** No TraceQL, no LogQL, no bidirectional
  correlation, no native Grafana alerting on pre-stored data.

### Alternative I: AWS CloudWatch OTLP endpoints (GA 2025)

AWS now provides native OTLP ingestion at `https://xray.{region}.amazonaws.com/
v1/traces` for traces and `https://logs.{region}.amazonaws.com/v1/logs` for
logs, with SigV4 authentication.

**Why we rejected it:**

- **Traces still land in X-Ray, not Tempo.** Standard OTel SDKs can send
  directly to CloudWatch/X-Ray without ADOT-specific exporters, but the
  backend is still X-Ray with all its limitations (50 annotations, 64KB
  segments, limited query language).
- **Does not solve the wide-event problem.** The OTLP endpoint is a transport
  improvement, not a storage improvement — X-Ray's data model constraints
  remain.

### Alternative J: Lambda → OTel → ClickHouse → Grafana

Export wide events as OTLP traces to ClickHouse instead of Tempo.

**Advantages:**

- **Best analytical query performance.** ClickHouse excels at high-cardinality,
  high-dimensionality aggregation queries. It would outperform Tempo for complex
  analytical queries over large datasets.
- **Viable future evolution.** If we outgrow Tempo's query capabilities, we can
  add ClickHouse as a secondary store (dual-writing from the OTel SDK) without
  changing instrumentation. This is a good "Phase 2" option.

**Why we deferred it (not rejected):**

- **Operational overhead.** Running a ClickHouse cluster is significantly more
  burden than Grafana Cloud's managed Tempo. Schema design, cluster scaling,
  backups, and upgrades are our responsibility.
- **Loss of native Grafana stack integration.** Tempo integrates natively with
  Grafana's trace visualization, exemplars, and cross-signal correlation
  (trace → log, trace → metric). ClickHouse as a trace backend requires custom
  dashboard work to achieve similar UX.

### Logging: console.log vs pino with OTel instrumentation

We considered using pino with `@opentelemetry/instrumentation-pino` to
automatically inject `trace_id` and `span_id` into every log record, enabling
bidirectional one-click correlation between Loki and Tempo.

**Advantages of pino + OTel instrumentation:**

- **Bidirectional one-click correlation.** Loki derived fields can extract
  `trace_id` and link directly to Tempo's trace view. Tempo links back to Loki
  filtered by the same trace ID. Both directions are seamless.
- **Span-level log correlation.** With `span_id` in logs, you can see which
  specific child span (e.g., a DB call) a log was emitted during.
- **Structured log fields.** Pino emits JSON with typed fields, making LogQL
  queries like `| json | userId="123"` possible.

**Why we chose plain console.log instead:**

- **Zero dependencies.** No pino, no `@opentelemetry/instrumentation-pino`.
  Two fewer packages to install, update, and debug. The Lambda runtime's
  `AWS_LAMBDA_LOG_FORMAT=JSON` provides `timestamp`, `level`, and `requestId`
  automatically.
- **Tempo is our query surface, not Loki.** All structured queryable data
  (user IDs, bucket names, error details) lives in span attributes, queryable
  via TraceQL. Logs are supporting detail — human-readable context for when
  you're already looking at a specific invocation. Span → logs correlation is
  already one-click via Tempo's `tracesToLogsV2` filtering by `requestId`.

If we later find that bidirectional one-click correlation or structured log
querying becomes important, migrating to pino is straightforward — it's an
additive change that doesn't affect the tracing pipeline.

---

## Consequences

### Positive

- **Minimal cold start overhead.** ~30–80ms for SDK initialization vs ~1000ms
  with Lambda layers. The biggest driver of this revision.
- **End-to-end OTel.** Single protocol from instrumentation to storage — no
  translation layers, no format conversions.
- **High-cardinality wide events are first-class.** Tempo stores span attributes
  natively without cardinality penalties. Unlimited queryable attributes per
  span.
- **One-click trace-to-logs.** Tempo links to Loki via `requestId`, showing all
  logs for a given invocation alongside the trace.
- **Independent signal pipelines.** Traces export directly to Tempo via OTLP;
  logs flow independently via stdout → CloudWatch → Firehose → Loki. A failure
  in one pipeline does not affect the other.
- **No sidecar process.** No collector extension to configure, debug, or
  maintain. No custom collector YAML configs.
- **Cost-efficient.** Within Grafana Cloud free tier at current scale. Firehose
  log delivery at $0.029/GB is the cheapest managed option.
- **Vendor-neutral instrumentation.** OTel SDK means we can switch backends
  without re-instrumenting.
- **Future-proof sampling.** Tail-based sampling via a gateway collector can be
  added without changing Lambda instrumentation.

### Negative

- **Per-invocation flush overhead.** `forceFlush()` adds ~30–100ms to every
  invocation (vs near-zero with the decouple processor in the layer approach).
  Acceptable tradeoff given the cold start savings.
- **No automatic instrumentation.** Without the auto-instrumentation layer, we
  must manually create root spans and explicitly instrument outbound HTTP/AWS
  SDK calls. More application code to maintain, but also more control.
- **Tempo is not an analytics engine.** Complex aggregate queries (GROUP BY
  across multiple high-cardinality dimensions over 30 days) will be slower than
  ClickHouse. Acceptable for now; ClickHouse can be added later as a secondary
  store.
- **Firehose infrastructure.** The log pipeline requires a Firehose delivery
  stream — one more AWS resource to provision via SST/Pulumi. Operationally
  simple but not zero.

---

## References

- [loggingsucks.com](https://loggingsucks.com) — wide-event / canonical log line philosophy
- [Grafana Loki: Cardinality documentation](https://grafana.com/docs/loki/latest/get-started/labels/cardinality/)
- [Grafana Tempo: Configuration & receivers](https://grafana.com/docs/tempo/latest/configuration/)
- [OTel Lambda Extension Layer](https://github.com/open-telemetry/opentelemetry-lambda)
- [Grafana blog: Observing Lambda with OTel and Grafana Cloud](https://grafana.com/blog/how-to-observe-aws-lambda-functions-using-the-opentelemetry-collector-and-grafana-cloud/)
- [AWS Firehose HTTP endpoint specification](https://docs.aws.amazon.com/firehose/latest/dev/httpdeliveryrequestresponse.html)
- [ADOT Lambda documentation](https://aws-otel.github.io/docs/getting-started/lambda/)
- [Grafana Tempo: Dedicated attribute columns](https://grafana.com/docs/tempo/latest/operations/dedicated_columns/)
