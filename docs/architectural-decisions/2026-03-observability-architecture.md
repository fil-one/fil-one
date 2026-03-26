# ADR: Observability Architecture for Serverless Wide Events

**Status:** Accepted
**Date:** 2026-03-24

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
- **Grafana** is our visualization and alerting layer (Grafana Cloud).
- **API Gateway V2 → CloudFront** is our routing layer — we want to keep this
  setup (no Lambda Function URLs).

We need an architecture that carries rich event data from Lambda functions to a
queryable backend, with reasonable cost, latency, and operational overhead.

### What we tried

Our first implementation (commits 2d1706d–7c3dcb7) used **two OTel Lambda
layers**: the upstream OTel Collector Extension running a sidecar collector
process, plus the OTel Node.js auto-instrumentation layer. This added ~1000ms
to every cold start and caused severely delayed telemetry from infrequent SQS
handlers. See Alternative A for details.

Our second implementation used the **manual OTel SDK** — no Lambda layers, no
sidecar, direct OTLP HTTP export to Grafana Cloud Tempo with synchronous
`forceFlush()`. This eliminated the cold start overhead from layers but
introduced a different problem: `forceFlush()` adds >500ms to cold-start
responses because AWS Lambda waits for the handler to complete before sending
the response. See Alternative B for details.

---

## Decision

**Lambda → `console.log` → CloudWatch Logs → Kinesis Firehose → Grafana Cloud
Loki** for logs. **CloudWatch Metrics → Metric Stream → Kinesis Firehose →
Grafana Cloud Prometheus** for metrics. No tracing or OpenTelemetry — the
performance penalty of synchronous trace export is too large for our Lambda +
API Gateway V2 setup.

### How it works

1. **Plain `console.log` for application logs.** Application logs use plain
   `console.log`/`warn`/`error` — no structured logging library needed. SST's
   `logging: { format: 'json' }` configures the Lambda runtime to emit JSON log
   records with `timestamp`, `level`, and `requestId` automatically.

2. **Log delivery via Firehose with CloudWatch retention.** Logs are written to
   CloudWatch Logs at standard ingestion ($0.50/GB) and kept with a short
   retention period (e.g. 7 days) for quick operational access via the AWS
   console. A Firehose subscription filter forwards the same logs to Grafana
   Cloud Loki for long-term storage and LogQL querying.

3. **Signal routing.**
   - **Logs → Loki** — JSON application logs with Lambda-injected `requestId`.
     Low-cardinality Loki labels (service, environment). LogQL for querying.
   - **Metrics → Prometheus** — AWS-provided metrics (Lambda invocations,
     duration, errors, throttles) via CloudWatch Metric Stream → Firehose →
     Grafana Cloud Prometheus. Custom application metrics via EMF planned as
     step 2. See below.
   - **Traces** — not implemented. Debugging relies on structured log queries
     in Loki, correlated by `requestId`.

4. **Debugging without traces.** Without distributed tracing, debugging relies
   on filtering logs by `requestId` in Loki (or CloudWatch Logs Insights for
   quick operational access). All contextual information needed for debugging
   should be logged explicitly. This is a tradeoff: we lose trace-based
   visualization and TraceQL queries, but gain zero telemetry overhead on every
   request.

### Metrics pipeline

Metrics delivery uses a two-step approach:

**Step 1 (implemented): AWS-provided metrics via CloudWatch Metric Stream.**
A CloudWatch Metric Stream forwards AWS-provided metrics (currently the
`AWS/Lambda` namespace) to Grafana Cloud Prometheus via a Kinesis Firehose
delivery stream. This gives us Lambda duration, invocations, errors, throttles,
and concurrent executions in Grafana dashboards with zero application code
changes. The pipeline:

- CloudWatch Metrics → Metric Stream (OpenTelemetry 1.0 format) → Firehose →
  Grafana Cloud Prometheus (`aws-metric-streams` endpoint)

Additional AWS namespaces (API Gateway, SQS, DynamoDB, etc.) can be added to
the Metric Stream's include filter as needed.

**Deployment scope.** The metric stream pipeline is deployed once per account via
the `infra/` stack (not per-stage via the main stack), because CloudWatch Metric
Streams are account-wide — a single stream captures all metrics in the
`AWS/Lambda` namespace regardless of which SST stage created the Lambda. This
avoids duplicate data from multiple stages sharing an account. Metric Streams
are also regional — if Lambdas are later deployed in multiple regions, a Metric
Stream is needed in each region. Developer stacks (which may use a different
region) do not get metrics streamed to Grafana; their metrics remain accessible
via the CloudWatch console.

**Step 2 (planned): Custom application metrics via EMF.**
Custom application metrics will use CloudWatch Embedded Metric Format (EMF):

- Emit EMF-formatted JSON to stdout from Lambda handlers, using low-cardinality
  dimensions (e.g. route, status code, error type) to avoid the CloudWatch
  cardinality trap.
- CloudWatch automatically extracts metrics from EMF log lines — no additional
  infrastructure needed for CloudWatch dashboards and alarms.
- The existing Metric Stream automatically picks up EMF-extracted metrics from
  the `AWS/Lambda` namespace (or a custom namespace if configured).

This is a direction to explore, not a finalized design. Details will be captured
in a separate ADR or update to this one once implemented.

### Lambda configuration

JSON log formatting is configured per Lambda via our `createFunction` helper in
`sst.config.ts`, which sets `logging: { format: 'json' }` on each function
definition.

---

## Alternatives Considered

| Approach                      | Cold start           | Wide events                    | Ops overhead                    | Verdict                   |
| ----------------------------- | -------------------- | ------------------------------ | ------------------------------- | ------------------------- |
| **A. OTel Lambda Layers**     | ~1000ms (two layers) | Full (span attrs)              | High (collector YAML, decouple) | Implemented then replaced |
| **B. Manual OTel SDK**        | >500ms (cold flush)  | Full (span attrs)              | Low (no sidecar)                | Implemented then replaced |
| **Chosen: C. Logs + EMF**     | Zero overhead        | Logs only (no spans)           | Low (Firehose)                  | Accepted                  |
| **D. ADOT Lambda Layers**     | 200ms–4s             | Full (span attrs)              | High (same as A)                | Rejected                  |
| **E. Grafana OTel Extension** | 100–300ms + layer    | Full (span attrs)              | Medium (pre-configured)         | Rejected                  |
| **F. Firehose → Tempo**       | N/A                  | N/A — protocol mismatch        | High (translation layer)        | Rejected                  |
| **G. JSON logs → Loki**       | Near-zero            | Limited (scan-based)           | Low                             | Rejected                  |
| **H. X-Ray + CloudWatch**     | Low (~50–100ms)      | 50 annotations, 64KB limit     | Low                             | Rejected                  |
| **I. Powertools (X-Ray)**     | Lowest (~50–100ms)   | 50 annotations, 64KB limit     | Lowest                          | Rejected                  |
| **J. EMF + X-Ray + CW**       | <5ms                 | Split across services          | Zero                            | Rejected                  |
| **K. CW OTLP endpoints**      | Low                  | 50 annotations (X-Ray backend) | Low                             | Rejected                  |
| **L. OTel → ClickHouse**      | Same as B            | Best (columnar)                | High (self-managed cluster)     | Deferred                  |

### Alternative A: OTel Lambda Extension Layers (implemented, then replaced)

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

### Alternative B: Manual OTel SDK → Grafana Cloud Tempo (implemented, then replaced)

Each Lambda function initializes an OTel `TracerProvider` with
`BatchSpanProcessor` and `OTLPTraceExporter` at module load. No Lambda layers,
no sidecar collector. Wide-event context is attached as span attributes,
queryable via TraceQL in Tempo. Before the handler returns, `forceFlush()` sends
a single OTLP HTTP POST to Grafana Cloud. Logs use plain `console.log` via the
CloudWatch → Firehose → Loki pipeline (same as the chosen approach). Metrics
were to be auto-derived from spans via Tempo's metrics-generator.

**We implemented this approach and rejected it due to two problems:**

- **`forceFlush()` adds >500ms to cold-start responses.** AWS Lambda waits for
  the handler to complete — including the OTLP HTTP POST — before sending the
  response to the client. On cold starts, this adds >500ms of user-visible
  latency, pushing total browser response times well over 1 second. Warm
  invocations are fine (<100ms total), but cold starts happen frequently enough
  to be unacceptable. Lambda response streaming could defer the flush to after
  the response, but API Gateway V2 does not support streaming — it only works
  with Lambda Function URLs (`InvokeMode: RESPONSE_STREAM`), and we want to
  keep our ApiGatewayV2 → CloudFront routing.
- **Metrics-generation from spans is hard to set up in Grafana Cloud.**
  Tempo's metrics-generator is disabled by default in Grafana Cloud. Enabling
  it requires either Application Observability (which only generates metrics
  for SERVER and CONSUMER span kinds by default — missing CLIENT spans like
  Auth0 calls) or contacting Grafana Support for custom settings. Neither
  option is self-service or IaC-friendly.

### Alternative D: ADOT Lambda Layers

AWS's own distribution of the OTel Lambda layer (ADOT) with Application Signals.

**Why we rejected it:**

- **Even worse cold starts.** ADOT layers add 200–500ms for newer versions, and
  500ms–4s for legacy collector-based versions. AWS labels the legacy
  collector-based approach "not recommended."
- **No advantage for Grafana Cloud export.** Exporting to non-CloudWatch
  endpoints (like Grafana Cloud OTLP) still requires the legacy layer with
  embedded collector — the newer Application Signals approach only supports
  CloudWatch/X-Ray destinations.

### Alternative E: Grafana's OTel Collector Lambda Extension

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

### Alternative F: Lambda → Kinesis Firehose → Grafana Tempo

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

### Alternative G: Lambda → Wide-event JSON logs → Grafana Loki

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

### Alternative H: X-Ray traces + CloudWatch logs, queried from Grafana

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

### Alternative I: Powertools for AWS Lambda (X-Ray + CloudWatch)

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

- **Same X-Ray limitations as Alternative H** — 50-annotation limit, 64KB
  segment size, one-directional correlation, deprecation timeline.
- **Log enrichment ≠ trace enrichment.** `appendPersistentKeys()` enriches
  _log lines_, not trace spans. The Tracer's `putAnnotation()` (50 indexed) and
  `putMetadata()` (not indexed) are far more limited than OTel span attributes.
- **No tail sampling path.** X-Ray supports head-based sampling only. The only
  cost control lever discards errors and successes at the same rate.
- **Error capture is split across services.** X-Ray tells you _which requests
  failed_ (fault/error/throttle status); CloudWatch Logs tells you _why_ (full
  stack traces, context).

### Alternative J: All-native AWS (EMF + X-Ray + CloudWatch)

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

Note: We adopt parts of Alternative J — specifically EMF for metrics — in the
chosen approach, but without X-Ray tracing and with Grafana Cloud (not
CloudWatch) as the query and alerting layer.

### Alternative K: AWS CloudWatch OTLP endpoints (GA 2025)

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

### Alternative L: Lambda → OTel → ClickHouse → Grafana

Export wide events as OTLP traces to ClickHouse instead of Tempo.

**Advantages:**

- **Best analytical query performance.** ClickHouse excels at high-cardinality,
  high-dimensionality aggregation queries. It would outperform Tempo for complex
  analytical queries over large datasets.
- **Viable future evolution.** If we outgrow Loki's query capabilities, we can
  add ClickHouse as a secondary store without changing application
  instrumentation. This is a good "Phase 2" option.

**Why we deferred it (not rejected):**

- **Operational overhead.** Running a ClickHouse cluster is significantly more
  burden than Grafana Cloud's managed services. Schema design, cluster scaling,
  backups, and upgrades are our responsibility.
- **Loss of native Grafana stack integration.** ClickHouse as a trace backend
  requires custom dashboard work to achieve the UX that Grafana's native stack
  provides out of the box.

### Logging: console.log vs pino

We considered using pino for structured logging with automatic JSON field
injection.

**Advantages of pino:**

- **Structured log fields.** Pino emits JSON with typed fields, making LogQL
  queries like `| json | userId="123"` possible.
- **Progressive context enrichment.** Pino's child loggers can accumulate
  context through middleware, similar to wide events.

**Why we chose plain console.log instead:**

- **Zero dependencies.** No pino package to install, update, and debug. SST's
  `logging: { format: 'json' }` configures the Lambda runtime to provide
  `timestamp`, `level`, and `requestId` automatically.
- **Sufficient for current needs.** Log querying in Loki via LogQL with JSON
  parsing covers our current debugging needs. If structured log querying becomes
  important, migrating to pino is straightforward — it's an additive change.

---

## Consequences

### Positive

- **Zero telemetry overhead per request.** No OTel SDK, no `forceFlush()`, no
  network calls for telemetry. Logs go to stdout (near-zero cost), which is the
  fastest path in Lambda.
- **Simplest possible stack.** `console.log` + CloudWatch + Firehose + Loki.
  No OTel dependencies, no collector, no sidecar, no Lambda layers.
- **Independent log pipeline.** Logs flow via stdout → CloudWatch → Firehose →
  Loki. Fully managed, no application-level failure modes.
- **Cost-efficient.** Within Grafana Cloud free tier at current scale. Firehose
  log delivery at $0.029/GB is the cheapest managed option.
- **Verified log pipeline.** The CloudWatch → Firehose → Loki pipeline has been
  tested and confirmed working end-to-end.
- **AWS metrics in Grafana.** CloudWatch Metric Stream forwards AWS-provided
  Lambda metrics (invocations, duration, errors, throttles) to Grafana Cloud
  Prometheus with zero application code changes.
- **Clear path to custom metrics.** EMF → CloudWatch Metrics → the existing
  Metric Stream → Grafana Prometheus can be added incrementally without
  affecting the logging pipeline.

### Negative

- **No distributed tracing.** Debugging relies on log queries filtered by
  `requestId`, not trace visualization. No span-based latency analysis, no
  trace waterfall views, no TraceQL. This is a significant observability
  regression compared to the OTel approaches — acceptable at current scale
  where most debugging is single-request investigation.
- **No custom application metrics yet.** AWS-provided Lambda metrics are
  available in Grafana via Metric Stream, but custom RED metrics (per-route
  rate, errors, duration) require EMF instrumentation (planned step 2).
- **Firehose infrastructure.** The log and metric pipelines each require a
  Firehose delivery stream plus supporting resources (S3 backup, IAM roles).
  Operationally simple but not zero.
- **Log-only wide events are limited.** High-cardinality fields in logs are
  queryable via LogQL JSON parsing, but this is scan-based — slower than
  Tempo's indexed span attributes for broad analytical queries.

---

## References

### Logs and metrics pipeline

- [loggingsucks.com](https://loggingsucks.com) — wide-event / canonical log line philosophy
- [Grafana Loki: Cardinality documentation](https://grafana.com/docs/loki/latest/get-started/labels/cardinality/)
- [AWS Firehose HTTP endpoint specification](https://docs.aws.amazon.com/firehose/latest/dev/httpdeliveryrequestresponse.html)
- [Grafana Cloud: Configure Logs with Firehose](https://grafana.com/docs/grafana-cloud/monitor-infrastructure/monitor-cloud-provider/aws/logs/firehose-logs/config-firehose-logs/)
- [AWS Lambda response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html) — requires Function URLs, not supported by API Gateway V2

### Tracing alternatives (evaluated and rejected)

- [Grafana Tempo: Configuration & receivers](https://grafana.com/docs/tempo/latest/configuration/)
- [Grafana Tempo: Dedicated attribute columns](https://grafana.com/docs/tempo/latest/operations/dedicated_columns/)
- [OTel Lambda Extension Layer](https://github.com/open-telemetry/opentelemetry-lambda)
- [Grafana blog: Observing Lambda with OTel and Grafana Cloud](https://grafana.com/blog/how-to-observe-aws-lambda-functions-using-the-opentelemetry-collector-and-grafana-cloud/)
- [ADOT Lambda documentation](https://aws-otel.github.io/docs/getting-started/lambda/)
