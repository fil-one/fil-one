# ADR: Alert on Billed Usage Drift Before Invoicing

**Status:** Accepted
**Date:** 2026-11-19

## Context

The usage reporting worker sends each org's period-average storage to a Stripe meter that keeps the last value reported in the period ([usage billing ADR](2026-03-usage-based-storage-billing.md)). A failed run costs nothing if a later run in the same period succeeds, yet the current alert, "Usage Reporting Worker - Daily Cron Success", fires on any worker error at any point in the period. It also misses drift that raises no error: a subscription row the scan skips, an average of zero that sends nothing, a missing Stripe customer, or a stale `currentPeriodStart`.

What matters is whether the value Stripe will invoice matches the storage the org used, close enough to the period end that the gap will reach the invoice.

## Decision

A read-only job, `jobs/billed-usage-drift-checker.ts`, runs at 09:00 and 21:00 UTC, two hours after usage reporting, and follows the [drift telemetry pattern](2026-04-subscription-drift-telemetry.md).

- **Who:** the subscriptions the usage run meters (`METERED_SUBSCRIPTIONS`) whose `currentPeriodEnd` is within 48 hours. Earlier gaps still have runs left to heal them. Trials and grace periods are left out: Stripe does not charge usage during a trial, and a grace-period row's subscription is already canceled, so neither has a usage invoice ahead.
- **Rows it cannot evaluate:** a metered row with no `stripeCustomerId`, `currentPeriodStart` or `currentPeriodEnd`, or whose `currentPeriodEnd` passed more than 12 hours ago. The last means a renewal webhook was missed, so the worker and this check would both average over the old period and agree on a wrong value. Each is logged as `[billed-usage-drift-checker] unchecked` with `orgId` and `reason`, and counted as a probe failure.
- **Blind spot:** a period ending in the two hours between a usage run and the next check is last seen by the check before that usage run. Missing only the final run shifts a period average by well under the 2% tolerance, so this misses only a large storage change in the period's last twelve hours.
- **Billed:** the meter's value for the current period, from `stripe.billing.meters.listEventSummaries`. No value counts as 0 GB.
- **Actual:** the period-average GB, computed by `getOrgAggregateUsage`, the same code the worker reports from.
- **Drift:** the gap exceeds both 2% of the larger value and 1 GB. One missed run moves a monthly average by a fraction of a percent, so a single failure stays under the line.
- **Signals:** per run, dimensionless EMF metrics `BilledUsageOrgsChecked`, `BilledUsageDrift` and `BilledUsageProbeFailed`. A run that cannot look up the meter or scan subscriptions reports one probe failure before it fails, so the checker-failure alert sees it. Per drifted org, one warning whose message is a JSON string with `event: "[billed-usage-drift-checker] out_of_sync"`, `orgId`, `subscriptionId`, `periodEnd`, `billedGb`, `actualGb`, `gapGb` and `gapPct`. It is a warning because production Lambdas drop `console.log`, and a JSON string because Node's printed objects cannot be parsed in LogQL.

### Alert rules

FilOne's rules live in the Grafana UI: folder FilOne, group "FilOne Alerts Evaluations", contact point FilOne.

1. **Billed usage drift before invoicing** (critical, `service_name=filone_billing`). Loki, so the alert names the org and the gap:

   ```logql
   sum by (orgId, gapGb, gapPct, periodEnd) (
     count_over_time(
       {service_name="filone-production", aws_log_group="/aws/lambda/filone-production-BilledUsageDriftChecker"}
         |= "out_of_sync" | json | line_format "{{.message}}" | json | __error__="" [12h]
     )
   )
   ```

   Fires when the value is above 0. The first `json` reads the Lambda's log envelope, the second the drift line in its `message`. Summary: `Org {{ $labels.orgId }} will be invoiced {{ $labels.gapGb }} GB ({{ $labels.gapPct }}%) off its actual storage; period ends {{ $labels.periodEnd }}.`

2. **Billed usage drift checker cannot read** (warning). Mimir: `max_over_time(BilledUsageProbeFailed[24h])` above 0 for two consecutive runs. A probe that always fails would otherwise hide real drift. On-call lists the affected orgs with `|= "unchecked"` on the checker's log group.

3. **Usage Reporting Worker - Daily Cron Success** moves to a non-paging route, and is deleted after one billing cycle in which rule 1 runs clean.

## Consequences

- An alert means an invoice is about to be wrong, and names the org, so on-call can rerun the worker for it before the period ends.
- Each run reads usage metrics and one Stripe meter summary per org in the window, about a fifteenth of metered orgs.
- `getOrgAggregateUsage` is now shared by the worker and the checker, so the comparison cannot drift from how usage is computed.
