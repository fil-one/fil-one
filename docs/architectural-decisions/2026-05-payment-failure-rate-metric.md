# ADR: Payment Failure Rate from InvoicePaid + DunningEscalation

**Status:** Accepted
**Date:** 2026-05-08

## Context

We need a payment-failure-rate SLO for billing. Two EMF metrics are
emitted from the Stripe webhook handler
([stripe-webhook.ts](packages/backend/src/handlers/stripe-webhook.ts)):

- **`InvoicePaid`** — emitted once on `invoice.payment_succeeded`, after the
  billing record write completes. One emission per successfully paid invoice.
- **`DunningEscalation`** — tagged with `stage` (`entered` / `retry` /
  `recovered` / `canceled`) and `reason`.

## Decision

Metric is computed as:

```promql
sum(increase(DunningEscalation{stage="canceled", reason="payment_failed"}[$__range]))
/
(
  sum(increase(InvoicePaid[$__range]))
  + sum(increase(DunningEscalation{stage="canceled", reason="payment_failed"}[$__range]))
)
```

### Why `DunningEscalation{stage="canceled", reason="payment_failed"}`

Stripe Smart Retries fire `invoice.payment_failed` multiple times per
invoice, so any metric counted on that event (including
`DunningEscalation{stage="entered"|"retry"}`) over-counts failures. Only the
`canceled` stage fires once per subscription, when Stripe has exhausted all
retries — this is the only point at which a failure is irrecoverable, and it
is the only stage that counts one event per failed billing outcome. The
`reason="payment_failed"` filter excludes voluntary cancellations.

## References

- [Stripe Smart Retries](https://docs.stripe.com/billing/revenue-recovery/smart-retries)
- [Observability ADR](2026-03-observability-architecture.md) — EMF pipeline.
- [SLOs.md](../SLOs.md) — destination for the Grafana panel and alert.
