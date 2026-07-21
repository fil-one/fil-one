# Plan: Self-healing for deleted Stripe customers

**Status:** Proposed
**Created:** 2026-07-21
**Related incident:** `cus_Ufz9bakVAlrQOR` / org `1b20adb4-87c2-4522-be5c-1ed3a7b3b86a`

## Background

On 2026-06-15 a Stripe customer was deleted manually via the Stripe Dashboard.
The `customer.deleted` webhook event was never delivered: the handler and the
`WEBHOOK_EVENTS` entry had shipped on 2026-06-04 (#411), but the Stripe
endpoint's `enabled_events` are only updated when the `SetupStack` custom
resource re-runs, which requires a manual `Version` bump in `sst.config.ts` —
and the next bump landed on 2026-06-23 (#448). The deletion fell into that gap.

The `customer.subscription.deleted` event (fired because deleting a customer
cancels its subscriptions) *was* delivered, but `handleSubscriptionDeleted`
silently returns when the customer is already deleted, so the billing record
was never closed out.

Consequences:

- The billing record stayed `trialing` forever, so the daily usage-reporting
  orchestrator kept dispatching the org.
- `UsageReportingWorker` errored on every run for 37 days
  (`No such customer`), unnoticed.
- The tenant was never disabled in the provisioned regions (FTH + Aurora), so
  the org kept receiving service with no billing relationship.

**Decision:** keep the manual `Version` bump mechanism as-is (explicitly out of
scope). Instead, make the system tolerant of missed `customer.deleted` events:
the usage worker — which already touches every non-canceled billing record
daily — becomes the reconciliation loop.

## Goals

1. `UsageReportingWorker` automatically heals state when the Stripe customer
   is gone but our DynamoDB record and tenant status (FTH + Aurora) are still
   live: disable the tenant in all provisioned regions, mark the billing
   record `canceled`, and stop reprocessing the org.
2. `customer.subscription.deleted` for an already-deleted customer closes out
   the billing record instead of silently no-oping (defense in depth — this
   alone would have prevented the incident).
3. A missed-deletion condition is observable (metric + log), not silent.

## Non-goals

- Automating the `SetupStack` version bump (kept manual by decision).
- A standalone Stripe↔DB reconciliation cron. The worker-based heal covers
  every record the orchestrator dispatches; see “Known limitations”.

---

## Shared foundation — `closeOutDeletedCustomer` helper

After Fixes 1 and 2 there are three call sites running the same core sequence:
`handleCustomerDeleted`, the fixed `handleSubscriptionDeleted`, and the worker
heal path. The sequence and its critical invariant are identical everywhere:
disable tenants in all provisioned regions first; if any region failed, do
**not** touch the billing record (so the caller's retry mechanism can
re-enter); otherwise mark the record canceled. That lives in one new module,
`packages/backend/src/lib/deleted-customer-cleanup.ts`:

```ts
export async function closeOutDeletedCustomer(params: {
  tableName: string;
  userId: string;
  orgId: string | null;   // null → nothing to disable, still cancel the record
  retry: RetryOptions;    // WEBHOOK_STATUS_SYNC_RETRY vs worker default budget
}): Promise<RegionSyncOutcome[]> {
  // 1. syncTenantStatusInProvisionedRegions(orgId, 'disabled', retry)
  // 2. any 'error' outcome → return outcomes WITHOUT updating the record
  // 3. UpdateItem: status=canceled, canceledAt, updatedAt,
  //    REMOVE gracePeriodEndsAt (condition: attribute_exists(pk))
  // 4. return outcomes
}
```

What stays **outside** the helper is exactly what genuinely differs per
caller:

- **Failure semantics.** Webhook callers pass the returned outcomes through
  `assertRegionSyncSucceeded` → throw → 500 → Stripe retries. The worker
  writes the `heal-failed:<regions>` audit record and waits for tomorrow's
  run. Same guard, two escalation styles — caller policy, not helper logic.
- **Retry budget.** `WEBHOOK_STATUS_SYNC_RETRY` (Stripe's ~2s response
  window) vs the worker's default `STATUS_SYNC_RETRY` (60s Lambda budget) —
  already parameterized in `lib/region-helpers.ts`, passed through.
- **Telemetry.** `emitDunningEscalation` for the webhook paths; the heal
  audit record + `StripeCustomerMissing` metric for the worker.

Deliberately **not** unified: the entry points. The webhook handlers start
from an event payload with the customer object in hand, while the worker
starts from an error signal and must do the verification retrieve as its
safety guard. Forcing both into one signature would make the helper's
contract murkier than the small duplication it saves.

Supporting lib refactors:

- Move `resolveOrgId` from `stripe-webhook.ts` into a lib module — it is a
  generic billing-record lookup needed by the webhook callers of the helper;
  handler files shouldn't be imported for it. (The worker doesn't need it:
  it has `orgId` in the payload.)
- Move `isStripeResourceMissing` (currently private in
  `usage-reporting-worker.ts`) next to the Stripe client utilities, and add
  `verifyCustomerDeleted(id): 'deleted' | 'not-in-account'` there — the
  deleted-vs-never-existed distinction gets one tested implementation instead
  of ad-hoc `'deleted' in customer` checks.

---

## Fix 1 — UsageReportingWorker self-healing (primary)

### Detection

The worker already observes `resource_missing` in two places:

- `reportStorageToStripe` (`usage-reporting-worker.ts`) — currently warns and
  skips.
- `syncOrgMetadata` — currently catches, logs an error, and returns
  `error:...` (the incident signature).

Both call sites will surface a `customerMissing` signal to the handler instead
of independently swallowing the error. When either reports it, the worker
enters the heal path and skips the remaining normal steps (metadata sync,
trial-lock enforcement).

### Verification guard (safety)

`resource_missing` alone is ambiguous, and the distinction matters:

| `stripe.customers.retrieve(id)` result | Meaning | Action |
| --- | --- | --- |
| Stub with `deleted: true` | Customer existed in this account and was deleted | Heal |
| Throws `resource_missing` | Customer never existed in this account/mode — likely a Stripe key/account misconfiguration | **Do not heal.** Log at error level, emit metric, keep the record untouched |

This guard is load-bearing: if the deployment were ever pointed at the wrong
Stripe account, every customer would 404, and healing without verification
would disable every tenant in production. With the guard, a misconfiguration
produces loud errors and no writes.

### Heal steps

The heal path calls `closeOutDeletedCustomer` (see "Shared foundation") with
the worker's default `STATUS_SYNC_RETRY` budget, then applies worker-specific
policy to the returned outcomes:

1. **Any region `error`** → the helper has left the record untouched. Write
   the audit record with `orgSyncAction: 'heal-failed:<regions>'`. Because
   the record stays non-canceled, tomorrow's run re-enters the heal path and
   retries the failed region (same self-healing property the webhook handler
   relies on).
2. **All regions succeeded** → the helper has marked the record `canceled`.
   Write the daily usage audit record with
   `orgSyncAction: 'healed:customer-deleted'` and `reportedToStripe: false`;
   emit an EMF metric (see Fix 3) and a structured log line containing
   `orgId`, `userId`, `stripeCustomerId`, and per-region outcomes.

After a successful heal the record is `canceled`, so
`scanActiveSubscriptionRecords` (`usage-reporting-orchestrator.ts`) excludes
it — the org drops out of the daily run permanently.

### Plumbing: `userId` in the worker payload

The billing record key is `CUSTOMER#<userId>`, but the worker payload
currently carries only `orgId`/`subscriptionId`/`stripeCustomerId`. Changes:

- `usage-reporting-orchestrator.ts`: extract `userId` from `record.pk`
  (`CUSTOMER#` prefix) in `scanActiveSubscriptionRecords`; add it to
  `SubscriptionRecord` and the dispatched payload.
- `usage-reporting-worker.ts`: add `userId?: string` to
  `UsageReportingWorkerPayload`.
- **Version skew:** for ≤1 orchestrator run during deploy, a worker may
  receive a payload without `userId`. In that case skip the heal entirely
  (warn log); the next daily run carries `userId`. Never heal tenants without
  also being able to close the record — a half-heal (tenant disabled, record
  live) is worse than waiting a day.

### Edge cases

- **Trial-lock enforcement is skipped on the heal path** — the tenant is being
  disabled outright; running `enforceTenantLocks` afterwards could not
  re-enable it (sync never downgrades `disabled`), but skipping avoids
  confusing double-writes in the audit trail.
- **`customers.retrieve` transient failure:** let the error propagate. The
  worker is invoked async (`InvocationType: Event`), so Lambda retries; the
  next daily run is a further backstop.
- **Concurrent webhook race:** if a late `customer.deleted` webhook processes
  the same customer, both paths converge on the same idempotent writes
  (status sync probes first; the DDB update is absolute).

---

## Fix 2 — `handleSubscriptionDeleted`: close out records for deleted customers

`packages/backend/src/handlers/stripe-webhook.ts` (`if ('deleted' in customer
&& customer.deleted) return;`) currently drops the event on the floor —
exactly the case where the record must be closed out.

Changes:

- Rewrite `handleCustomerDeleted` on top of `closeOutDeletedCustomer` (see
  "Shared foundation") — its body today is exactly that sequence plus
  `resolveOrgId` and `emitDunningEscalation`, which stay in the handler.
- In `handleSubscriptionDeleted`, when the retrieved customer is deleted:
  resolve `userId` from `subscription.metadata.userId` (both creation paths
  set it) and call the same helper instead of returning. If `userId` is
  absent, throw — a 500 lets Stripe retry, matching `handleCustomerDeleted`
  semantics.
- Both call sites keep webhook failure semantics: pass the helper's outcomes
  through `assertRegionSyncSucceeded` with `WEBHOOK_STATUS_SYNC_RETRY`
  (throw → 500 → Stripe retries; the helper's tenants-before-record ordering
  means a retry resumes the incomplete part).

Out of scope: `handlePaymentSucceeded` / `handlePaymentFailed` also
early-return on deleted customers, but those events don't gate record
closure; leave them (Fix 1 covers any residue).

---

## Fix 3 — Observability

- **New EMF metric** from the worker heal path (pattern:
  `lib/stripe-webhook-metrics.ts`), e.g. `StripeCustomerMissing` with a
  dimension for the outcome: `healed`, `heal-failed`, `not-in-account`
  (verification-guard hit). Alert on any non-zero `not-in-account` and on
  repeated `heal-failed`.
- **Recommended alarm** (infra follow-up): alert on `UsageReportingWorker`
  ERROR-level logs. The incident ran 37 days without anyone noticing; the
  audit trail (`orgSyncAction != 'ok'`) made it trivially visible in
  hindsight but nothing watched it.
- **Log hygiene:** add `customerId`/`subscriptionId` to the
  `"Customer deleted, skipping subscription update"` log line (and audit the
  other skip-paths in `stripe-webhook.ts` for missing IDs). The June 15
  investigation was blind partly because this line carries no identifiers.
- **Comment in `setup-integrations.ts`** next to `WEBHOOK_EVENTS`: changing
  this list has no effect until the `SetupStack` `Version` in `sst.config.ts`
  is bumped. Cheap insurance now that the bump stays manual.

---

## Testing

The invariant "no record update when any region fails" is tested once, at the
`closeOutDeletedCustomer` level (`deleted-customer-cleanup.test.ts`): all
regions ok → record canceled; one region `error` → no `UpdateItem` issued;
`orgId: null` → record canceled with no sync attempted. Caller tests then
only cover their own policy on the returned outcomes.

Unit tests (existing patterns: `usage-reporting-worker.test.ts`,
`stripe-webhook.test.ts` with `aws-sdk-client-mock` + mocked Stripe client):

| Case | Expected |
| --- | --- |
| Meter event or metadata sync throws `resource_missing`; retrieve → `deleted: true` | Regions synced to `disabled`, record updated to `canceled`, audit `healed:customer-deleted`, metric emitted |
| `resource_missing`; retrieve → throws `resource_missing` | No writes; error log + `not-in-account` metric; audit `error:...` |
| Heal with one region `error` | No record update; audit `heal-failed:<region>`; next-run retry still possible |
| Payload without `userId` | No heal; warn log; normal error audit |
| Non-`resource_missing` Stripe error | Propagates (unchanged behavior) |
| `subscription.deleted`, customer deleted, `metadata.userId` present | Tenants disabled, record `canceled`, dunning metric |
| `subscription.deleted`, customer deleted, no `metadata.userId` | 500 (Stripe retries) |

Integration test (optional, `tests/integration/jobs/usage-reporting-worker.test.ts`
harness): seed billing record, create + delete a real test-mode customer,
invoke the worker, assert record `canceled`.

## Rollout

1. Ship Fixes 1–3 (single PR or worker/webhook split; no `WEBHOOK_EVENTS`
   change, so **no version bump needed**).
2. The next daily orchestrator run auto-heals org `1b20adb4-…` — and any other
   customer deleted during the June 4–23 subscription gap — with no manual DB
   edits. Verify via audit records (`orgSyncAction: healed:customer-deleted`)
   and tenant status in both regions.
3. Confirm with the teammate who deleted the customer that disabling the org
   is the intended outcome (it will happen automatically on deploy).
4. Add the ERROR-log alarm (infra follow-up).

## Known limitations

- The worker returns early for orgs with no provisioned region
  (`getProvisionedRegions` → empty), before any Stripe call — a dangling
  record for a never-provisioned org won't heal. There is also no tenant to
  disable in that case; the record merely keeps producing a daily skip-log.
  Acceptable for now; a standalone reconciliation cron can be revisited if
  this becomes noisy.
- Records already `canceled` with stale `stripeCustomerId`s are invisible to
  the orchestrator and stay stale — harmless by design.
