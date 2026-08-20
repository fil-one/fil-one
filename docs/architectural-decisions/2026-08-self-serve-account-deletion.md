# ADR: Self-serve account deletion

**Status:** Accepted
**Date:** 2026-08-13

## Context

Self-service account deletion is unavailable today. Building it means removing state across multiple separate systems with unrelated failure modes: DynamoDB (`UserInfoTable`, `BillingTable`, `RagIndexerTable`), Stripe, regional storage orchestrators, Auth0, and the S3 Vector indexes.

It's not possible to do an atomic cleanup across all these systems. Partially finished teardowns are therefore normal rather than exceptional. The design has to decide two things: where the point of no return sits, and what happens after each partial failure.

## Decisions

### 1. Deletion starts at the confirmation

After the user submits the deletion confirmation code, one DynamoDB transaction spends the code, writes the `DELETION` record and raises the profile fence. The transaction is the same three items at any org size. The `202` is returned after the transaction commits. From that moment the account is unusable: every session request is refused with a `410` by the fence check in decision 5, and new resource creation is refused. The data plane is the exception: S3 access keys are not sessions, so uploads and downloads continue until the tenant-disable step in decision 7, seconds after the confirm in the normal case and bounded by the sweeper pickup when the invoke is lost.

These writes share a transaction because a spent code must never exist without a `DELETION` record behind it. Codes are rate limited, so a user left in that state cannot simply retry.

Confirmation is not the only trigger. An admin deleting the org's Stripe customer, the standing response to trial abuse, commits the same deletion: the `customer.deleted` webhook writes the `DELETION` record and raises the profile fence in one transaction, with no code to spend, and invokes the same worker. The handler resolves the org from the deleted customer's `orgId` metadata, which is written at customer creation, and falls back to the billing-row lookup for customers that predate the metadata. The record write is conditional on no record existing, which makes the teardown's own `customer.deleted` echo a no-op and makes the two triggers converge instead of compounding. The record names its trigger, so the erasure receipt distinguishes a user's request from an admin action.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant API as API Lambda
    participant DDB as DynamoDB
    participant W as Worker
    participant Cron as Sweeper (15m)

    User->>API: confirm { code, orgName }
    API->>DDB: TransactWriteItems — spend code, write record, raise fence
    Note over API,DDB: commitment boundary
    API-)W: invoke (Event)
    API-->>User: 202
    W->>W: Auth0 → Stripe → tenants → rows → DONE
    alt worker throws, or the invoke never landed
        Cron->>DDB: scan status != DONE, updatedAt < now-30m
        Cron-)W: re-invoke — the whole run repeats
    end
```

After the transaction is committed the deletion worker is invoked. If the invocation fails, the sweeper picks the deletion up after at most about 45 minutes: the 30-minute staleness window plus up to one 15-minute sweep interval. Confirm does not fail the request when the invocation fails, since the record is the source of truth rather than the invocation.

### 2. Teardown is idempotent; error recovery means re-running the teardown job

Given that every step of the teardown is idempotent, recovering from errors simply means re-running the whole teardown. With idempotency being a property of the teardown / deletion worker we were able to avoid usage of state machines and need for checkpointing.

This works because no teardown step is asynchronous on the vendor side. Every external call either finishes inside the call or fails. A step that reports its progress asynchronously would break the model and should reopen this ADR rather than add progress tracking to the record.

Two requirements follow from re-running, and both are easy to lose in a refactor:

- The worker's first read of the `DELETION` record is strongly consistent. An eventually consistent read immediately after the confirm transaction can miss the record and burn a retry.
- The worker updates `updatedAt` and increments `attempts` in one write at the start of every pass. The first keeps the cron from re-driving a teardown that is progressing normally; the second is the counter decision 10's blocked-deletion alert reads.

### 3. Records are scrubbed, not purged

Deleting an account does not delete the rows that describe it. Every row that survives keeps its key, loses its personal data, and gains `deletedAt`. One attribute answers both questions: the row is deleted when `deletedAt` exists, and the timestamp says when, with no separate boolean to drift out of agreement with it. The rows that do not survive are destroyed outright. Which of the two applies is decided per record in decision 9.

The scrub is the only writer of this stamp. It is the worker's final step, and it sets `deletedAt` on every retained row in the same update that removes the row's personal data. Before that step runs, the org profile's `deleting`, raised at confirm, is the only deletion marker in the tables: `deleting` is the fence, `deletedAt` is the terminal marker.

**Personal data** here means names, email addresses, phone numbers, postal addresses and payment-card details. **System identifiers are not considered personal data** — `orgId`, `userId`, `sub`, `stripeCustomerId`, `subscriptionId`, tenant ids and Stripe object ids are all retained, as are timestamps, counters, status enums and role assignments.

That definition leaves very little to scrub. Across every retained row, exactly two things are personal data: the org profile's `name`, and the card-description fields on the billing row. The `deletedAt` stamp does the rest of the work. All the other personal data sits in rows that are destroyed outright, which is what separates the two categories.

Three properties of the code make retention better than a purge.

**A purge needs a conditional write that another ADR forbids.** `createBillingTrial` reads the billing row and returns before any Stripe call, so an existing row makes it a no-op. Its write must stay an unconditional `UpdateItem`: a conditional put silently no-ops when the `customer.subscription.created` webhook wins the race, which is how 254 orgs lost their `stripeCustomerId`. [The billing read-model ADR](2026-07-billing-read-model-never-synthesizes-entitlement.md) ends "do not reintroduce a conditional write here." It is therefore the one billing writer that cannot carry a row-exists guard. After a purge it recreates the row and mints a Stripe customer postdating the teardown — chargeable, with nothing left to cancel it. Retention makes it a permanent no-op, which is a stronger guarantee than any fence.

**A retained row is inert to every reader, with no new filters.** The scrub writes `subscriptionStatus = canceled` directly — the worker sets it, rather than leaving it to the cancellation webhook. All three lifecycle scans already exclude that status: usage reporting requires `subscriptionStatus <> canceled`, the grace-period enforcer requires `grace_period`, the drift checker requires `active`. The subscription guard answers `canceled` with its existing response. A purged row is worse than a scrubbed one — the guard reads "no row" as "possibly a new user" and calls `ensureTrialEntitlement`.

**Retaining the org profile keeps its fence alive permanently.** The profile carries `deleting`, and tenant setup writes its tenant id with an unconditional upsert. Deleting the profile removes the fence, so a tenant-setup call still in flight recreates a stub profile holding a tenant id. That row is invisible to both the stuck-tenant metric and `advanceStatus`. Deleting the profile last narrows the window; retaining it closes it. `recordSetupFailure` already guards itself the same way.

### 4. Confirmation is terminal

Retention does not grant reversibility. A **reversible** deletion offers a restore path, and that is outside of the scope of this ADR. A **scrubbed** record keeps only a key; its personal data is gone and its account cannot come back. No row that survives decision 3 can restore an account, and nothing reads `deletedAt` as a provisional state.

The safeguard sits ahead of the confirmation instead: a code emailed to the requesting admin, plus typing the org name. A grace period would make the guards in decision 5 provisional and force every reader of `deleting` to tell a reversible state from a final one.

### 5. Multiple deletion guards

The system has many write paths, so two guards divide them between each other. The profile fence covers everything a session or a credential can reach; the billing fence covers the asynchronous writers that have neither.

| Guard                                                | Written at                               | Stops                                                                                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORG#/PROFILE.deleting = true`                       | confirm, re-applied each pass            | every session on its next request; RAG bearer-key queries; resource creation: access keys, RAG keys, buckets, tenant setup, RAG enablement; every background job, which skips the org |
| `attribute_not_exists(deletedAt)` on billing updates | scrub, when `deletedAt` lands on the row | a Stripe webhook writing personal data back to a scrubbed billing row                                                                                                                 |

**The request paths read the profile fence.** The flag is read at two points on a request's timeline. `authMiddleware` reads it after resolving the identity row and answers `410` when it is set, which is what makes the confirm kill every member's session at once. Each creation writer then checks the same flag again immediately before its irreversible action, because a request that passed auth before the fence landed can stay in flight for up to API Gateway's 29 seconds, and the auth-time check does nothing for a request already past it. Where the writer's final action is a DynamoDB write, the check is a condition on that write and the refusal is atomic. Where the resource is minted upstream (a bucket, an access key, a Stripe subscription), the check sits just ahead of the mint and narrows the window the deferred-risk section bounds. The RAG bearer path reads the same flag at query time, because a standalone credential has no session for the middleware to refuse.

The auth-time check costs one extra sequential `GetItem` per authenticated request, sequential because the `orgId` only becomes known from the identity read the middleware already makes. The read is eventually consistent, which halves its cost, and the staleness it admits is milliseconds. A missing profile row fails open. Decision 3 retains the profile with `deleting` set permanently, so the refusal is permanent with no second flag for the terminal state. The check runs before the trial-entitlement backfill in the middleware, so a deleted org's login cannot trigger it.

Fencing sessions on the org profile rather than on per-member identity rows keeps the confirm transaction at three items regardless of org size, and it refuses a member added while the deletion is in flight, for whom no identity row existed at confirm. The identity row still gains `deletedAt` at scrub, as decision 9 records: the stamp preserves the known-user branch in auth and marks the terminal state on the row itself, and the middleware's check of it stays as defense in depth on a read it already makes.

The request-path billing writers need no fence of their own: the two lazy transitions in `get-billing`, `transitionExpiredTrial` and `create-setup-intent`. Each one runs only inside an authenticated request, and the profile fence answers `410` before any handler or the subscription guard executes. They are unreachable for a deleted account, so a row-level condition would add nothing.

**The Stripe callbacks are fenced on the billing row.** The profile fence cannot stop Stripe, which holds no session and retries its callbacks for days, so the billing fence covers the one row those callbacks write. The guard is one condition, not two. The DynamoDB semantics here run against intuition: `UpdateItem` evaluates a condition on a missing item as though its attributes are absent, so `attribute_not_exists(deletedAt)` is _true_ for a row that does not exist and will create one. The single clause is sufficient only because decision 3 retains the row — it is never missing, so the fence has nothing to fail open against. Under a purge design this condition alone would have been a bug.

This guard is work to do, not a property we already have. On `main` a row-exists condition sits on two of roughly fourteen writers to `CUSTOMER#/SUBSCRIPTION`. This work routes all five webhook writers and the activation write through one guarded helper, so no unguarded writer can be added by omission. A refused write is a no-op rather than an error: the helper catches the `ConditionalCheckFailedException`, logs it and returns normally, so the handler answers Stripe with a `2xx`. A handler that threw instead would be retried by Stripe for days over a row that will never accept the write, and enough failures would disable the webhook endpoint.

The guard also makes webhook arrival order irrelevant, and the teardown itself causes that race. Cancelling the subscription and deleting the customer fire `customer.subscription.deleted`, the `invoice.*` events and `customer.deleted`, all delivered asynchronously and retried. The worker never waits for any of them. It writes `canceled` itself, and only after the cancellation at Stripe has succeeded, since the scrub is the last step and a failed cancel ends the pass before it. The row and Stripe therefore cannot disagree about the terminal state: a webhook arriving before the scrub is overwritten and one arriving after is refused. The terminal state does not depend on webhook delivery at all. The `customer.updated` handler matters most, being the only writer that can put payment-card details back onto a scrubbed row.

`closeOutDeletedCustomer` does not survive this work. Its job, disabling tenants and cancelling the billing record when Stripe reports a customer gone, is a subset of the teardown, and its trigger is not an accident to contain: an admin deleting the org's Stripe customer is the standing response to trial abuse and means the account should go. The `customer.deleted` handler therefore starts the full deletion, as decision 1 describes, and the usage-reporting worker's deleted-customer audit routes through the same entry point. The conditional `DELETION` record write carries the coordination: on the teardown's own echo the record already exists, the write is refused, and the handler acknowledges with a `2xx`. This also retires the old retry contract, in which the handler answered `500` so that Stripe's webhook retries would re-drive a failed region sync. The record and the sweeper own retries now, and the webhook always acknowledges.

**The background jobs skip the org.** Each scheduled job skips any org whose profile carries `deleting`, failing closed when the profile is missing, the opposite of the request paths' fail-open choice; `isOrgDeletedOrDeleting` exists as a separate predicate for exactly that split. This is what covers the window between confirm and scrub, where the billing row is still webhook-writable and carries neither `canceled` nor `deletedAt`, so the scan filters alone would admit it. A webhook flipping the row to `active` mid-teardown is therefore harmless: the scrub overwrites it, and no job acts on it in the meantime.

Setting `canceled` on the scrubbed row keeps it inert to every reader, and this work also adds `attribute_not_exists(deletedAt)` to the filter expressions of the three lifecycle scans. The invariant is then enforced twice: the status keeps the row out of each scan's business logic, and the filter keeps it out even if a refactor changes how a scan treats statuses.

### 6. Verification code gets its own table

The deletion challenge codes get a new `DeletionChallengeTable` rather than a place in `UserInfoTable` or `BillingTable`.

There are two reasons for this:

- `UserInfoTable` has no TTL configured. Enabling it there would make any accidental write of `ttl` attribute on an identity row a silent hard delete of account data.
- `BillingTable` has TTL and already holds `ORG#` partitions. But a short-lived security credential there widens what the billing writers' IAM policy covers and widens the scope of the table.

The code is stored as an HMAC-SHA256 over `orgId:userId:salt:code`, rather than a plain digest, since a six digit code is cheap to enumerate offline from a table dump. Verification happens inside a `ConditionExpression`, so the digest never reaches our process. The plaintext is never persisted.

The HMAC key is a single deployment-wide secret, held as an `sst.Secret` alongside the other key material. It is what stands between a table dump and the code space, and an HMAC rather than `sha256(secret‖message)` because the keyed construction needs no argument about length extension or where in the message the secret sits.

The `salt` in that message is 16 random bytes per row, stored in plaintext beside the digest. It adds nothing against a dump — the attacker reads it out of the same row — and it does not domain-separate rows, which `orgId:userId` already does. What it buys is that the stored digest is not a pure function of the code: codes are re-issuable on a cooldown, so without it the same code recurring for the same user stores the same digest, and one historical disclosure of a (digest, code) pair would stay useful against that user indefinitely.

A per-row salt is only possible because this row is found by its `orgId`, not by its hash. Anywhere the hash _is_ the key, computing it would mean reading the salt out of the row the hash locates, so the deployment-wide secret has to carry the whole burden. That is the case in decision 9, and it is why the two hashing sites differ.

### 7. Delete the Stripe customer rather than redacting it

At the time of writing this ADR Stripe redaction API is in public preview and therefore not part of any stable version SDK.

To avoid using preview APIs we have opted for the simpler solution of deleting the Stripe customer records.

Stripe customer cleanup has the following steps:

- Tenants are disabled in every provisioned region
- Outstanding usage is reported
- The default payment method is looked up
- The subscription is canceled
- A single attempt is made to collect the outstanding balance using that payment method
- The customer is deleted

Disabling the tenants first stops consumption before the final report, so the meter is not moving underneath the figure the customer is billed for. A request already in flight when the disable lands can still add its last writes, and that residue goes unbilled; it is bounded by a request timeout measured in seconds. If tighter numbers are ever needed, the tenant disable can move ahead of the Auth0 step, so real teardown work provides the settling time instead of a timer.

The report itself is the same per-org call the 12-hourly cron makes, and repeating it is safe: the meter aggregates `last_during_period`, so a re-driven pass submits the same or a fresher absolute value rather than a delta. It must run before the cancel, because a meter event after cancellation lands on no invoice. It still resolves the org's regions after the disable, because disabling is a status change that leaves the profile's region list intact; only tenant deletion, which comes later, empties that list.

Cancellation is a separate step because `customers.del` cancels subscriptions silently and issues no invoice. The explicit cancel is what makes the outstanding usage billable at all.

A single best-effort attempt is made to collect the payment. A declined card must not block the teardown, and it does not need to: an outstanding invoice does not block customer deletion and stays open for finance afterwards.

Deleting the customer removes the payment methods attached to it on Stripe's side; Stripe's documentation states that deleting a customer removes all credit card details. Our own copies, the `paymentMethod*` attributes on the billing row, are scrubbed in decision 9, so no card data survives on either side. Invoices and charges are unaffected and keep referencing the customer id, so finance keeps the linkage either way.

When the deletion was triggered by the customer's deletion in Stripe, the customer is already gone when the worker runs. Every step in this list treats a missing or already-deleted customer as success and moves on, the same contract decision 2 sets for Auth0's `404`. The final period goes unbilled in that flow, which is the intended outcome for the abuse case it serves.

### 8. Teardown order

Steps run strictly sequentially, as there is no hard constraint on the teardown duration. Teardown happens in the following order:

- Auth0: for each member, the worker reads the email from the management API, deletes the `ALLOWLIST#` row that email keys, then deletes the Auth0 user
- Stripe records, in the order decision 7 gives, billing the customer while the guards are up
- Tenant deletion
- Scrubbing org records: RAG keys, RAG state, billing record, ORG profile, ORG member profiles

Sessions are already refused at confirm by the profile fence, so no step is racing to lock the account and the order follows the data dependencies. Stripe cleanup precedes tenant deletion because the usage report must land on a live subscription and resolves the org's regions from the profile, as decision 7 orders.

The Auth0 step goes first, and its three actions run in a fixed order: the email read and the allowlist delete precede the user delete, because the allowlist row is keyed by an email no retained row stores and Auth0 is the only place it can be read. A re-run that gets a `404` on the lookup skips the row for that member, which is safe because the in-step ordering guarantees the user is only gone once a previous pass finished the removal. Deleting an already-deleted Auth0 user likewise returns `404`, which the worker treats as success and moves past. `sub` originates in the JWT and is written to DynamoDB at signup, and decision 9 retains it on two rows, so it stays available as the audit correlation key after the Auth0 user is gone.

One provider cannot complete its step. Aurora's Backoffice and Portal APIs expose no tenant DELETE, so `deleteTenant` disables the tenant and stops there; FIL-919 tracks the DELETE. An Aurora org therefore keeps its buckets and objects behind a deleted account, which is acceptable for the `customer.deleted` trigger — the response to trial abuse, where an inert account is the point — but not for a user who asked to be erased. Self-serve deletion is therefore withheld: `ACCOUNT_DELETION_ENABLED` is off on every stage, both HTTP routes answer `501`, and the console offers no button. The `customer.deleted` path in decision 1 is not gated and stays live. Removing the flag is part of FIL-919, not a separate decision.

The destroyed rows go after every step that needs them: the RAG key lookup row's key derives from the token hash stored on the key row, and the `RagIndexerTable` keys are what address the vector indexes. The scrubbed rows keep their identifiers either way, so their position is free; they go last so a failed pass leaves the most context for troubleshooting. The pass ends by setting the `DELETION` record's status to `DONE`, which is what removes it from the sweeper's scan.

### 9. Which records survive

| Record                         | Outcome                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `SUB#/IDENTITY`                | Retained and stamped. Keeps a live JWT out of the new-user path                |
| `USER#/PROFILE`                | Retained and stamped. Holds `sub`, the audit correlation key                   |
| `ORG#/MEMBER#`                 | Retained and stamped. `role` and `joinedAt` are not personal data              |
| `ORG#/PROFILE`                 | Retained, stamped, `name` removed. Keeps `deleting`, `createdBy`, tenant ids   |
| `CUSTOMER#/SUBSCRIPTION`       | Retained, stamped, card fields removed, worker writes `canceled`               |
| `ORG#/USAGE_REPORT#`           | Retained unchanged. Financial record, no personal data, expires on its own TTL |
| `ORG#/DELETION`                | Retained. The erasure receipt                                                  |
| Access keys, RAG keys, lookups | Destroyed. Credentials                                                         |
| `RagIndexerTable` rows         | Destroyed. Object keys and bucket names sit in the keys                        |
| `WEBHOOK#/EVENT`               | Left alone. Expires on its own 30-day TTL                                      |
| `ALLOWLIST#`                   | Destroyed. The worker resolves its email key from Auth0; see below             |
| `EMAIL_NORM#`                  | Left alone. Anti-abuse record; see below                                       |

On the billing row the scrub removes `paymentMethodId`, `paymentMethodLast4`, `paymentMethodBrand`, `paymentMethodExpMonth` and `paymentMethodExpYear`. `stripeCustomerId`, `subscriptionId` are system identifiers and stay, though the last of them then references an object Stripe deletes along with the customer.

Stamping the identity row rather than emptying it is a correctness requirement. Auth middleware branches on the row carrying both `userId` and `orgId`. A row stripped of them falls through to the new-user path, which mints fresh ids and then cancels its own transaction against the still-present key, producing a `500` on every login attempt instead of a clean refusal. Retaining the identifiers keeps that branch intact: the profile fence answers the `410`, and the row's own `deletedAt` stamp marks the terminal state and backs the fence up on a read the middleware already makes. Destroying the row would be worse still. The Auth0 user is deleted, so the same subject can never authenticate again, but a deleted member's still-valid JWT would find no row, take the new-user path successfully, and mint a fresh user, org and trial. Retention is what turns that token into a refusal.

Credentials are destroyed rather than retained, because a scrubbed credential row is still a credential row and retention buys nothing. The RAG key lookup row cannot be scrubbed at all: its delete path conditions on `orgId`, so stripping that attribute would block key deletion permanently. In `RagIndexerTable` the object keys and bucket names sit inside the primary keys, where attribute scrubbing is a structural no-op.

`ALLOWLIST#` is keyed by a plaintext email address, and the worker deletes it by resolving that key while it still can: inside the Auth0 step, the email read and the allowlist delete come before the user delete, as decision 8 orders. The row needs no scrub, since its presence is the grant and deleting it revokes the grant. Rows for live users stay keyed by plaintext email, which keeps the access list readable.

`EMAIL_NORM#` shares the key shape and cannot take the same treatment. No retained row stores a user's email, so once the Auth0 user is gone the key cannot be reconstructed, and the row must survive regardless: it is the anti-abuse record that prevents a second free trial. Rekeying it to a keyed hash of the address, with no per-row salt for the reason decision 6 gives, is what removes this personal data, and it ships as **its own PR with a migration** rather than inside the deletion work. The migration repoints the primary key of a live record whose writer claims it with `attribute_not_exists(pk)`, so a partial run either grants a second free trial or locks a legitimate user out of their first.

### 10. Observability

The teardown has no duration target, so the signal is not how long a deletion took but whether one has stopped making progress. Three EMF metrics in the `FilOne` namespace carry that, all emitted by the sweeper:

- `StuckAccountDeletionCount` — a gauge of records past the staleness window, emitted on every run including when it is zero, so an alert on `> 0` auto-clears.
- `BlockedAccountDeletion` — emitted once a record passes ten attempts, with a paired structured `console.error` carrying `orgId`. The metric drives the alert and the log line identifies the org through a Loki JSON query, the same pattern the FTH errors and tenant-setup failures use, so the metric needs no dimension and stays inside the cardinality rule of the [drift-telemetry ADR](2026-04-subscription-drift-telemetry.md).
- `OldestPendingDeletionAgeHours` — the age of the oldest record not yet `DONE`, emitted on every run. A Grafana alert at 168 hours encodes the seven-day completion promise in the customer documentation, and the threshold can move without touching code.

All three reach Grafana Cloud with no infrastructure change, since `FilOne` is already in the metric stream's include filter. The deletion worker's failed asynchronous invocations land in a dead-letter queue whose depth arrives the same way, `AWS/SQS` being in that filter too.

Alert rules and panels for these metrics live in Grafana Cloud, outside this repository. `docs/SLOs.md`, which two earlier metric ADRs name as the destination for panels and alerts, does not exist; revisiting that reference is out of scope here.

## Consequences

### Accepted costs

| Cost                                                                | Reasoning                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Up to ~45 minutes before teardown starts, if the invoke is lost     | The 30-minute staleness window plus up to one 15-minute sweep interval. Deletion need not be immediate; the fences already made the control plane inert.                                                                   |
| The data plane stays live between confirm and tenant disable        | Access keys are not sessions, so no fence reaches them. The disable lands seconds after confirm in the normal case; the bound is the sweeper pickup when the invoke is lost.                                               |
| The sweeper runs a full-table `Scan`                                | Fine at current table size. Revisit when RCUs or scan duration show up in cost or latency; the fix is a sparse GSI on an attribute present only while `PENDING`.                                                           |
| Seconds of in-flight consumption after tenant disable go unbilled   | Bounded by a request timeout: sessions are dead at confirm and creation is fenced, so only requests already in flight when the disable lands can still write.                                                              |
| Every authenticated request pays one extra sequential DynamoDB read | The session fence lives on the org profile, which keeps the confirm transaction at three items at any org size. A few milliseconds at the median; a per-container cache can absorb it if it ever shows in latency budgets. |
| Finalized invoices keep their `customer_email` snapshot             | They are immutable, and retained on the same legal-obligation basis as the rest of the financial record.                                                                                                                   |
| An Aurora org's buckets and objects outlive its teardown            | Aurora exposes no tenant DELETE, so the step disables the tenant and the record still reaches `DONE`. Tolerable only for the `customer.deleted` trigger, which is why self-serve deletion is off until FIL-919.            |
| Deleted orgs keep a row in every partition they occupied            | The rows carry no personal data and no entitlement, and total under 10 KB per org. Retention is what makes the guards in decision 5 cheap and the re-runs in decision 2 possible.                                          |

### Deferred risk

A tenant-setup request that read the profile before `deleting` landed can create an upstream tenant, then be refused when it records the id. The result is a tenant with no local pointer. The window is bounded by API Gateway's 29-second timeout.

Tenant setup should recover from this itself. When the conditional write is refused, it re-reads the profile with a consistent read. If the profile is deleting, it deletes the tenant it just created. If not, the refusal is an ordinary lost race and falls through to the existing handler. Telling the two apart requires the refused write to return the current item, which also stops the caller asserting on a tenant id nobody will ever write.

Aurora already makes that distinction and raises a distinct error for it. The generic orchestrator path lets the raw conditional-check failure become an indistinguishable `503`. Aligning them is part of this work.

Reconciliation against provider tenant lists is filed as its own ticket and remains the backstop for anything this recovery misses. Growing the worker to cover it would trade a bounded leak for permanent complexity in the teardown path.

## Open questions

None blocks the architecture. The first two need a decision owner outside engineering; the third is a verification task.

| Item                                                              | Owner   | What is needed                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An uncollectable final invoice                                    | Finance | The teardown makes one best-effort charge attempt and leaves the invoice open when the card declines. Stripe retains the deleted customer as retrievable history and the finalized invoice keeps its `customer_email` snapshot, so manual collection remains possible; automated dunning does not, since the customer has no payment methods and accepts no further operations. Finance needs to confirm the outcome and own the open invoice. |
| HubSpot retains the contact, with email and marketing preferences | Product | Delete the contact as a worker step, or document the retention as a lawful basis. As a step it inherits the same idempotency contract, where 404 counts as success.                                                                                                                                                                                                                                                                            |

## References

- [Billing read model never synthesizes entitlement](2026-07-billing-read-model-never-synthesizes-entitlement.md) — why the `createBillingTrial` write cannot be conditional.
- [Observability architecture](2026-03-observability-architecture.md) — the EMF and metric-stream pipeline decision 10 relies on.
- [Subscription drift telemetry](2026-04-subscription-drift-telemetry.md) — the per-invocation metric pattern, and the cardinality rule decision 10 stays within.
- [Synchronous tenant setup on first resource](2026-05-synchronous-tenant-setup-on-first-resource.md) — the stuck-gauge precedent.
- [Usage-based storage billing](2026-03-usage-based-storage-billing.md) — the meter aggregation that makes a repeated usage report safe.
