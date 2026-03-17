# ADR-001: Observability Architecture for Serverless Wide Events

**Status:** Accepted
**Date:** 2026-03-17

---

## Context

We are building the management console for an S3-compatible object storage product. The console runs on AWS Lambda and handles operations such as bucket creation and deletion, access key management, object uploads and downloads, and usage/billing queries. We need production observability that supports the "wide event" pattern — emitting a single, context-rich structured event per request per service, with many high-cardinality fields (account IDs, access key IDs, bucket names, object keys, request IDs, feature flags, storage tier metadata, etc.). This enables debugging through structured queries rather than grep-based log archaeology.

Our constraints are:

- **AWS Lambda** is our primary compute platform.
- **OpenTelemetry (OTel)** is our instrumentation standard — we want vendor-neutral telemetry.
- **Grafana** is our visualization and alerting layer (Grafana Cloud).

We need an architecture that carries rich, high-cardinality event data from Lambda functions to a queryable backend, with reasonable cost, latency, and operational overhead.

---

## Decision

**Lambda → OTel Lambda Extension Layer → Grafana Cloud OTLP endpoint**, routing traces to Tempo, logs to Loki, and metrics to Mimir.

### How it works

1. **Instrumentation.** Each Lambda function includes the OpenTelemetry Lambda Extension Layer (Grafana's distribution or the upstream OTel layer). The layer embeds a stripped-down OTel Collector as a Lambda Extension that registers with the Lambda Telemetry API.

2. **Wide events as span attributes.** Instead of emitting flat JSON log lines, we attach all wide-event context (account metadata, bucket configuration, access key scope, storage tier, feature flags, error details) as attributes on the OTel span representing the Lambda invocation. High cardinality is a non-issue in span attributes — this is what Tempo is designed for.

3. **Async export via the decouple processor.** The embedded collector uses a `decouple` processor that separates receiving and exporting, allowing the Lambda to return immediately. Telemetry is flushed during the next invocation or at shutdown, so we don't pay for idle flush time.

4. **Signal routing.** The collector configuration exports:
   - **Traces → Tempo** — wide-event spans with all business context as attributes, queryable via TraceQL.
   - **Logs → Loki** — lean stdout/stderr output only, with low-cardinality labels (service, environment, log level). No wide-event fields in Loki labels.
   - **Metrics → Mimir** — RED metrics (rate, errors, duration) auto-derived from spans via Tempo's metrics-generator or OTel's `spanmetrics` connector.

5. **Sampling.** Head-based sampling is configurable via the `OTEL_TRACES_SAMPLER` environment variable. For tail-based sampling (keep all errors, sample successful requests at a lower rate), we can run a small OTel Collector gateway that Lambda layers export to, which makes sampling decisions before forwarding to Tempo. This is out of the scope of the initial implementation.

6. **Correlation in Grafana.** Grafana dashboards link metrics → traces → logs via shared trace IDs and service labels, giving full drill-down from a dashboard anomaly to the exact wide-event span to the raw log output.

### Lambda layer setup

We use **two** Lambda layers in combination:

1. **Grafana Collector Extension** (`opentelemetry-collector-grafana-amd64`) — runs
   an OTel Collector as a Lambda extension process. It receives telemetry on
   `localhost:4318` and exports to Grafana Cloud. We chose Grafana's distribution
   over the upstream OTel collector layer because it includes built-in Grafana
   Cloud authentication via `GRAFANA_CLOUD_INSTANCE_ID` and
   `GRAFANA_CLOUD_API_KEY_ARN` environment variables — no custom `collector.yaml`
   required. The API key is stored in AWS Secrets Manager and the extension
   fetches it at startup using the ARN.

2. **OTel Node.js Auto-Instrumentation** (`opentelemetry-nodejs`) — wraps the
   Lambda handler via `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-handler`. It
   auto-creates a root span per invocation and child spans for AWS SDK v3 and
   fetch (undici) calls. This layer bundles OTel JS SDK v2, so our application
   code does **not** install SDK packages — it only imports `@opentelemetry/api`
   to read and enrich the existing spans.

We selectively enable instrumentations via
`OTEL_NODE_ENABLED_INSTRUMENTATIONS=aws-sdk,undici,aws-lambda` to minimize cold
start overhead (the layer ships with many instrumentations disabled by default).

### Attribute enrichment pattern

Because the auto-instrumentation layer creates root spans automatically and
already sets HTTP method, path, response status code, and error status, our
application code acts as a **lightweight attribute enricher**, not a span
creator. A Middy middleware (`tracingMiddleware`) runs as the first middleware in
each HTTP handler chain:

- **before hook:** stores the active span reference on the Middy request so
  downstream middleware can add custom attributes.

The auth middleware then enriches the span with `filone.user_id` and
`filone.org_id` after successful authentication.

The error handler middleware (`errorHandlerMiddleware`) records caught exceptions
on the span via `getRequestSpan(request)?.recordException(error)`. This is
colocated with the error handler rather than in `tracingMiddleware` because middy
runs `onError` hooks in reverse registration order — the error handler runs
first and swallows the error before other middleware sees it.

Non-API Lambda functions (SQS subscribers, cron jobs) receive the same layers
and environment variables for automatic root spans and AWS SDK child spans, but
do not use the HTTP-specific `tracingMiddleware`.

### Lambda environment variables

```
# OTel auto-instrumentation
AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-handler
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<stage>,service.namespace=filone
OTEL_SERVICE_NAME=filone-backend
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_NODE_ENABLED_INSTRUMENTATIONS=aws-sdk,undici,aws-lambda

# Grafana Cloud (used by collector extension layer)
GRAFANA_CLOUD_INSTANCE_ID=<instance_id>
GRAFANA_CLOUD_API_KEY_ARN=arn:aws:secretsmanager:<region>:<account>:secret:filone/<stage>/grafana-cloud-api-key-<suffix>
GRAFANA_CLOUD_OTLP_ENDPOINT=https://otlp-gateway-prod-us-central-0.grafana.net/otlp
```

---

## Alternatives Considered

### Alternative A: Lambda → Kinesis Firehose → Grafana Tempo

Route wide events through Kinesis Data Firehose using its HTTP endpoint destination to push data to Tempo.

**Why we rejected it:**

- **Protocol mismatch.** Firehose uses a proprietary JSON envelope format with custom headers (`X-Amz-Firehose-Protocol-Version`, `X-Amz-Firehose-Request-Id`) and a specific acknowledgment response contract. Tempo expects OTLP protobuf. There is no native compatibility — a translation layer is required.
- **Translation layer overhead.** We would need either an OTel Collector fleet (with the `awsfirehose` receiver) or an API Gateway + Lambda transformer sitting between Firehose and Tempo. Both add operational complexity, cost, and failure modes.
- **Latency.** Firehose buffers data with a minimum delivery interval of 60 seconds (configurable up to 900 seconds). Wide events would arrive at Tempo with at least a one-minute delay, making real-time incident debugging impractical.
- **Authentication friction.** Firehose only passes credentials via the `X-Amz-Firehose-Access-Key` header. Tempo/Grafana Cloud expects standard `Authorization` headers. The translation layer must also bridge auth.
- **Double cost.** We would pay for Firehose ingestion per GB, plus the translation layer compute, plus Tempo ingestion — when a direct OTel export eliminates the first two entirely.
- **Data model impedance.** Firehose treats records as opaque blobs. Converting flat wide-event JSON into properly formed OTLP spans (with trace IDs, span IDs, resource vs. span attributes) requires non-trivial transformation logic that is error-prone and hard to test.

### Alternative B: Lambda → Wide-event JSON logs → Grafana Loki

Emit wide events as structured JSON log lines and store them directly in Grafana Loki.

**Why we rejected it:**

- **Cardinality explosion.** Loki is architecturally designed for low-cardinality labels and long-lived streams. Wide events are inherently high-cardinality (account IDs, access key IDs, bucket names, object keys, request IDs). Using these as Loki labels creates massive index bloat, tiny chunks in the object store, and degraded query performance. Loki's own documentation explicitly warns against this and defaults to a limit of 15 index labels.
- **Structured metadata is scan-based.** Loki's structured metadata feature can store high-cardinality fields without indexing them, but querying structured metadata fields is a brute-force scan, not an index lookup. Broad analytical queries ("all bucket creation failures for enterprise accounts grouped by error code and region") over large time ranges become slow.
- **No columnar query model.** The wide-event philosophy envisions running analytics on production traffic. Loki's query engine (LogQL) parses JSON from each matching log line at query time. This is fundamentally different from a columnar store where each field is in its own compressed column. Aggregation queries are significantly slower.
- **Log volume cost.** A 50-field wide event is ~1-2KB per request. At scale — our storage API handles thousands of object operations per second — this translates to hundreds of GB per day of raw log ingestion. On Grafana Cloud, Loki pricing per GB ingested makes this expensive. Tempo's storage model is more efficient for structured span data.

### Alternative C: Lambda → OTel → ClickHouse → Grafana

Export wide events as OTLP traces, but store them in ClickHouse (a columnar analytics database) instead of Tempo, and query via Grafana's ClickHouse data source plugin.

**Why we deferred it (not rejected):**

- **Best analytical query performance.** ClickHouse excels at exactly the kind of high-cardinality, high-dimensionality aggregation queries that the wide-event philosophy calls for. It would outperform Tempo for complex analytical queries over large datasets.
- **Operational overhead.** Running a ClickHouse cluster is significantly more operational burden than using Grafana Cloud's managed Tempo. We would need to manage schema design, cluster scaling, backups, and upgrades.
- **Loss of native Grafana stack integration.** Tempo integrates natively with Grafana's trace visualization, exemplars, and cross-signal correlation (trace → log, trace → metric). ClickHouse as a trace backend requires more custom dashboard work to achieve similar UX.
- **Viable future evolution.** If we outgrow Tempo's query capabilities for analytical use cases, we can add ClickHouse as a secondary store (dual-writing from the OTel Collector) without changing our instrumentation. This is a good "Phase 2" option.

### Alternative D: Lambda → CloudWatch → Grafana (via CloudWatch data source)

Use AWS-native observability: CloudWatch Logs for wide events, X-Ray for traces, CloudWatch Metrics for dashboards, all visualized in Grafana via data source plugins.

**Why we rejected it:**

- **Vendor lock-in.** Instrumentation would use AWS-specific APIs (X-Ray SDK, CloudWatch Logs API) rather than OTel, violating our vendor-neutrality constraint.
- **Limited query capability on wide events.** CloudWatch Logs Insights can query structured JSON, but its query language is limited compared to TraceQL for trace-shaped data. Complex cross-field aggregations are cumbersome.
- **Cost at scale.** CloudWatch Logs ingestion pricing ($0.50/GB) plus Logs Insights query pricing ($0.005/GB scanned) becomes expensive at high log volumes. Retention costs compound over time.
- **Poor correlation.** Linking X-Ray traces to CloudWatch Logs to CloudWatch Metrics requires manual setup and doesn't match the seamless correlation experience of the Grafana LGTM stack with shared OTel context.

---

## Consequences

### Positive

- **End-to-end OTel.** Single protocol from instrumentation to storage — no translation layers, no format conversions.
- **High-cardinality wide events are first-class.** Tempo stores span attributes natively without cardinality penalties.
- **Low latency.** Telemetry arrives in seconds via the decouple processor, not minutes via Firehose buffering.
- **Cost-efficient.** No Firehose charges, no translation compute. Tempo's object-storage backend (S3/GCS) is cheap for trace data.
- **Vendor-neutral instrumentation.** OTel SDK and semantic conventions mean we can switch backends later without re-instrumenting.
- **Unified Grafana experience.** Metrics, traces, and logs correlated in a single UI via shared trace IDs.

### Negative

- **Cold start overhead.** The OTel Lambda Extension Layer adds ~100-300ms to cold starts for collector initialization. Mitigate with provisioned concurrency for latency-sensitive functions.
- **Tempo is not an analytics engine.** Complex aggregate queries (GROUP BY across multiple high-cardinality dimensions over 30 days) will be slower than a columnar store like ClickHouse. Acceptable for now; ClickHouse can be added later as a secondary store if needed.
- **Delayed telemetry for infrequent functions.** For Lambda functions invoked rarely, the decouple processor may hold data until the next invocation or shutdown — telemetry for a single invocation could be delayed by minutes or hours if the function goes cold.
- **Sampling complexity for tail-based.** Head-based sampling is trivial (env var). Tail-based sampling requires a separate OTel Collector gateway, adding one more component to operate.

---

## References

- [loggingsucks.com](https://loggingsucks.com) — wide-event / canonical log line philosophy
- [Grafana Loki: Cardinality documentation](https://grafana.com/docs/loki/latest/get-started/labels/cardinality/)
- [Grafana Loki: Structured metadata](https://grafana.com/docs/loki/latest/get-started/labels/structured-metadata/)
- [Grafana Tempo: Configuration & receivers](https://grafana.com/docs/tempo/latest/configuration/)
- [OTel Lambda Extension Layer](https://github.com/open-telemetry/opentelemetry-lambda)
- [Grafana Collector Lambda Extension](https://github.com/grafana/collector-lambda-extension)
- [Grafana blog: Observing Lambda with OTel and Grafana Cloud](https://grafana.com/blog/how-to-observe-aws-lambda-functions-using-the-opentelemetry-collector-and-grafana-cloud/)
- [AWS Firehose HTTP endpoint specification](https://docs.aws.amazon.com/firehose/latest/dev/httpdeliveryrequestresponse.html)
- [ADOT Lambda documentation](https://aws-otel.github.io/docs/getting-started/lambda/)
