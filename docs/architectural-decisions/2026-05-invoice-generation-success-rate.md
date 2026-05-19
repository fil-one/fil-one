# ADR: Invoice Generation Success Rate from `InvoiceFinalized` + `InvoiceFinalizationFailed`

**Status:** Accepted
**Date:** 2026-05-15

## Context

`InvoicePaid` and `DunningEscalation` cover payment collection, but they say
nothing about whether Stripe was able to _generate_ the invoice in the first
place. Finalization can fail silently for reasons that don't surface in payment
metrics — tax-engine outages, broken price IDs, missing required customer
fields, currency mismatches. We need a signal at this boundary so a regression
can't sit invisible.

Two EMF metrics are emitted from the Stripe webhook handler
([stripe-webhook.ts](../../packages/backend/src/handlers/stripe-webhook.ts)):

- **`InvoiceFinalized`** — emitted once on `invoice.finalized` (draft → open).
  Dimensionless. One emission per successfully generated invoice.
- **`InvoiceFinalizationFailed`** — emitted once on
  `invoice.finalization_failed` (draft discarded), tagged with `reason` from
  `last_finalization_error.code` (or `"unknown"` when absent).

## Decision

Metric is computed as:

```promql
sum(increase(InvoiceFinalized[$__range]))
/
(
  sum(increase(InvoiceFinalized[$__range]))
  + sum(increase(InvoiceFinalizationFailed[$__range]))
)
```

`reason` on `InvoiceFinalizationFailed` is intended for breakdown panels so the
top failure modes are visible without re-deriving them from logs.

### Why `invoice.finalized` / `invoice.finalization_failed` and not `invoice.created`

`invoice.created` fires when a draft is opened, including drafts that are
intentionally discarded (e.g. proration drafts that the upgrade flow voids).
Finalization is the point where Stripe commits the invoice to the customer,
which is what "did we successfully generate this bill" actually means.

## References

- [Stripe invoice lifecycle](https://docs.stripe.com/invoicing/overview)
- [Payment failure rate ADR](2026-05-payment-failure-rate-metric.md) — the
  collection-side counterpart to this metric.
- [Observability ADR](2026-03-observability-architecture.md) — EMF pipeline.
- [SLOs.md](../SLOs.md) — destination for the Grafana panel and alert.
