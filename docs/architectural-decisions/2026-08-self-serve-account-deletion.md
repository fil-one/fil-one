# ADR: Self-serve account deletion

**Status:** Proposed
**Date:** 2026-08-13

## Context

Self-service account deletion feature is unavailable today. Building it means removing state across multiple separate systems with unrelated failure modes: DynamoDB (`UserInfoTable`, `BillingTable`, `RagIndexerTable`), Stripe, regional storage orchestrators, Auth0, and the S3 Vector indexes.

It's not possible to do an atomic cleanup across all these systems. Partially finished teardowns are therefore normal rather than exceptional. The design has to decide two things: where the point of no return sits, and what happens after each partial failure.

## Decisions

### 1. Deletion starts at the confirmation

After the user submits the deletion confirmation code a transactional write to the DynamoDB is invoked writing the `DELETION` record, and raises the write fences. The `202` status code is returned after the transaction is committed. From that moment on the account is unusable: all sessions are killed and new resource creation is refused.

These writes share a transaction because a spent code must never exist without a `DELETION` record behind it. Codes are rate limited, so a user left in that state cannot simply retry.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant API as API Lambda
    participant DDB as DynamoDB
    participant W as Worker
    participant Cron as Sweeper (15m)

    User->>API: confirm { code, orgName }
    API->>DDB: TransactWriteItems — spend code, write record, raise fences
    Note over API,DDB: commitment boundary
    API-)W: invoke (Event)
    API-->>User: 202
    W->>W: Auth0 → Stripe → tenants → rows → DONE
    alt worker throws, or the invoke never landed
        Cron->>DDB: scan status != DONE, updatedAt < now-30m
        Cron-)W: re-invoke — the whole run repeats
    end
```

After the transaction is committed deletion worker is invoked. In the case of invocation failing the deletion will be picked up within up to 30 minutes by the cron worker and a new invocation will be issued. Confirm does not fail the request when the invocation fails, since the record is the source of truth rather than the invocation.

### 2. Teardown is idempotent; error recovery means re-running the teardown job

Given that every step of the teardown is idempotent, recovering from errors simply means re-running the whole teardown. With idempotency being a property of the teardown / deletion worker we were able to avoid usage of state machines and need for checkpointing.

This works because no teardown step is asynchronous on the vendor side. Every external call either finishes inside the call or fails. A step that reports its progress asynchronously would break the model and should reopen this ADR rather than add progress tracking to the record.

Two requirements follow from re-running, and both are easy to lose in a refactor:

- The worker's first read of the `DELETION` record is strongly consistent. An eventually consistent read immediately after the confirm transaction can miss the record and burn a retry.
- The worker updates `updatedAt` at the start of every pass, otherwise the cron re-drives a teardown that is progressing normally.

### 3. Records are scrubbed, not purged

Deleting an account does not delete the rows that describe it. Every row that survives keeps its key, loses its personal data, and gains `deleted` and `deletedAt`. The rows that do not survive are destroyed outright. Which of the two applies is decided per record in decision 9.

**Personal data** here means names, email addresses, phone numbers, postal addresses and payment-card details. **System identifiers are not considered personal data** — `orgId`, `userId`, `sub`, `stripeCustomerId`, `subscriptionId`, tenant ids and Stripe object ids are all retained, as are timestamps, counters, status enums and role assignments.

That definition leaves very little to scrub. Across every retained row, exactly two things are personal data: the org profile's `name`, and the card-description fields on the billing row. The `deleted` flag does the rest of the work. All the other personal data sits in rows that are destroyed outright, which is what separates the two categories.

Three properties of the code make retention better than a purge.

**A purge needs a conditional write that another ADR forbids.** `createBillingTrial` reads the billing row and returns before any Stripe call, so an existing row makes it a no-op. Its write must stay an unconditional `UpdateItem`: a conditional put silently no-ops when the `customer.subscription.created` webhook wins the race, which is how 254 orgs lost their `stripeCustomerId`. [The billing read-model ADR](2026-07-billing-read-model-never-synthesizes-entitlement.md) ends "do not reintroduce a conditional write here." It is therefore the one billing writer that cannot carry a row-exists guard. After a purge it recreates the row and mints a Stripe customer postdating the teardown — chargeable, with nothing left to cancel it. Retention makes it a permanent no-op, which is a stronger guarantee than any fence.

**A retained row is inert to every reader, with no new filters.** The scrub writes `subscriptionStatus = canceled` directly — the worker sets it, rather than leaving it to the cancellation webhook. All three lifecycle scans already exclude that status: usage reporting requires `subscriptionStatus <> canceled`, the grace-period enforcer requires `grace_period`, the drift checker requires `active`. The subscription guard answers `canceled` with its existing response. A purged row is worse than a scrubbed one — the guard reads "no row" as "possibly a new user" and calls `ensureTrialEntitlement`.

**Retaining the org profile keeps its fence alive permanently.** The profile carries `deleting`, and tenant setup writes its tenant id with an unconditional upsert. Deleting the profile removes the fence, so a tenant-setup call still in flight recreates a stub profile holding a tenant id. That row is invisible to both the stuck-tenant metric and `advanceStatus`. Deleting the profile last narrows the window; retaining it closes it. `recordSetupFailure` already guards itself the same way.

### 4. Confirmation is terminal

Retention does not grant reversibility. A **reversible** deletion offers a restore path, and that is outside of the scope of this ADR. A **scrubbed** record keeps only a key; its personal data is gone and its account cannot come back. No row that survives decision 3 can restore an account, and nothing reads `deleted` as a provisional state.

The safeguard sits ahead of the confirmation instead: a code emailed to the requesting admin, plus typing the org name. A grace period would make the guards in decision 5 provisional and force every reader of `deleting` to tell a reversible state from a final one.

### 5. Multiple deletion guards

Due to our system having multiple write paths multiple deletion guards / fences had to be installed. These guards prevent new resource creation, resurection of the deleted records and request authentication.

| Guard                                              | Written at                    | Stops                                                                           |
| -------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| `ORG#/PROFILE.deleting = true`                     | confirm, re-applied each pass | resource creation: access keys, RAG keys, buckets, tenant setup, RAG enablement |
| `SUB#/IDENTITY.deleted = true`                     | confirm                       | every existing session, on its next request                                     |
| `attribute_not_exists(deleted)` on billing updates | added by this work            | a Stripe webhook writing personal data back to a scrubbed billing row           |

None of the three covers the other two. `deleting` cannot guard a write that creates its own row, as there is no row yet to carry the condition. The identity flag stops the user but not third-party callbacks made on their behalf. The billing fence covers the row both of the others miss.

The billing guard is one condition, not two. The DynamoDB semantics here run against intuition: `UpdateItem` evaluates a condition on a missing item as though its attributes are absent, so `attribute_not_exists(deleted)` is _true_ for a row that does not exist and will create one. The single clause is sufficient only because decision 3 retains the row — it is never missing, so the fence has nothing to fail open against. Under a purge design this condition alone would have been a bug.

This guard is work to do, not a property we already have. On `main` a row-exists condition sits on two of roughly fourteen writers to `CUSTOMER#/SUBSCRIPTION`. This work routes all five webhook writers and the activation write through one guarded helper, so no unguarded writer can be added by omission. A refused write is a no-op rather than an error: the caller has nothing to fix, and a webhook handler that threw would be retried by Stripe for days over a row that will never accept the write.

The guard also makes webhook arrival order irrelevant, and the teardown itself causes that race. Cancelling the subscription and deleting the customer fire `customer.subscription.deleted`, the `invoice.*` events and `customer.deleted`, all delivered asynchronously and retried. The worker never waits for any of them. It writes `canceled` itself, so a webhook arriving before the scrub is overwritten and one arriving after is refused. The terminal state does not depend on webhook delivery at all. The `customer.updated` handler matters most, being the only writer that can put payment-card details back onto a scrubbed row.

Not every writer takes the write guard. `closeOutDeletedCustomer` is fenced at its entry instead, because it disables tenants before it reaches the billing row and a condition on its write would come too late. Its webhook callers already read that row to resolve the org, so the fence rides on the read they make anyway: project `deleted` alongside `orgId` and return early when the flag is set. The check belongs in the function rather than its callers, since four webhook paths reach it.

The request-path writers need no billing fence at all: the two lazy transitions in `get-billing`, `transitionExpiredTrial` and `create-setup-intent`. Each one runs only inside an authenticated request, and `authMiddleware` rejects a flagged identity with a `410` before any handler or the subscription guard executes. They are unreachable for a deleted account, so a row-level condition would add nothing. Stripe has no session to lose, which is precisely why its callbacks need the fence and these do not — the identity flag stops the user, the billing fence stops Stripe.

Setting `canceled` on the scrubbed row is load-bearing and must survive refactoring. The grace-period enforcer has no guard; a retained row escapes it only because that cron's scan filters on `subscriptionStatus = grace_period`. Dropping the status on the grounds that the row is flagged anyway re-arms the cron silently.

### 6. Verification code gets its own table

Decision has been made to create a new `DeletionChallengeTable` rather that saving deletion challenge codes in `UserInfoTable` or `BillingTable`.

There are two reasons for this:

- `UserInfoTable` has no TTL configured. Enabling it there would make any accidental write of `ttl` attribute on an identity row a silent hard delete of account data.
- `BillingTable` has TTL and already holds `ORG#` partitions. But a short-lived security credential there widens what the billing writers' IAM policy covers and widens the scope of the table.

The code is stored as a salted hash over `orgId:userId:salt:code`, rather than a plain digest, since a six digit code is cheap to enumerate offline from a table dump. Verification happens inside a `ConditionExpression`, so the digest never reaches our process. The plaintext is never persisted.

The salt is a single deployment-wide secret, held as an `sst.Secret` alongside the other key material. A per-row random salt cannot work anywhere the hash is a key: the row is found _by_ the hash, so computing it would mean reading the salt out of the row the hash locates. The same constraint applies in decision 9.

### 7. Delete the Stripe customer rather than redacting it

At the time of writing this ADR Stripe redaction API is in public preview and therefore not part of any stable version SDK.

To avoid using preview APIs we have opted for a simpler solution of deleting the stripe customer records.

Stripe customer cleanup has the following steps:

- Outstanding usage is reported
- Default payment method is collected
- Subscription is canceled
- Single attempt is made to collect any outstanding payments using the default payment method
- Customer is deleted

Reporting usage first is what makes the final period billable. It is the same per-org call the 12-hourly cron makes, and repeating it is safe: the meter aggregates `last_during_period`, so a re-driven pass submits the same or a fresher absolute value rather than a delta. Two orderings are required. It must run before the cancel, because a meter event after cancellation lands on no invoice. It must also run before tenant teardown, because the reporting path resolves an org's regions from its profile and emits nothing when that list is empty.

Cancellation is a separate step because `customers.del` cancels subscriptions silently and issues no invoice. The explicit cancel is what makes the outstanding usage billable at all.

A single best effort attempt it made to collect the user payment. A declined card must not block the teardown, and it does not need to: an outstanding invoice does not block customer deletion and stays open for finance afterwards.

Deleting the customer deletes all of their payment information. Invoices and charges are unaffected and keep referencing the customer id, so finance keeps the linkage either way.

### 8. Teardown order

Steps run strictly sequentially as there is no hard constraint on the teardown duration. Teardown happends in the following order:

- Deleting Auth0 user
- Stripe records — it's worth noting that we will bill the customer once the guards are up
- Tenant deletion
- Scrubbing org records: RAG keys, RAG state, billing record, ORG profile, ORG member profiles

Auth0 goes first because it is the authentication root, and so the one fence no missed code path can route around. Nothing later depends on it. `sub` originates in the JWT and is written to DynamoDB at signup, no teardown step reads anything from Auth0, and decision 9 retains `sub` on two rows, so it stays available as the audit correlation key indefinitely. This costs one thing: deleting an already-deleted Auth0 user returns `404`, which the worker treats as success, so a pass that died before marking the record done looks identical to one that never started.

Scrubbing comes last because those rows hold the pointers to the tenants and the Stripe customer, so they go after everything they point at. Within that step the RAG key lookup rows go before the org partition, because a lookup row's key derives from the token hash stored on the key row.

### 9. Which records survive

| Record                         | Outcome                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `SUB#/IDENTITY`                | Retained and flagged. Prevents re-signup by the same Auth0 subject             |
| `USER#/PROFILE`                | Retained and flagged. Holds `sub`, the audit correlation key                   |
| `ORG#/MEMBER#`                 | Retained and flagged. `role` and `joinedAt` are not personal data              |
| `ORG#/PROFILE`                 | Retained, flagged, `name` removed. Keeps `deleting`, `createdBy`, tenant ids   |
| `CUSTOMER#/SUBSCRIPTION`       | Retained, flagged, card fields removed, worker writes `canceled`               |
| `ORG#/USAGE_REPORT#`           | Retained unchanged. Financial record, no personal data, expires on its own TTL |
| `ORG#/DELETION`                | Retained. The erasure receipt                                                  |
| Access keys, RAG keys, lookups | Destroyed. Credentials                                                         |
| `RagIndexerTable` rows         | Destroyed. Object keys and bucket names sit in the keys                        |
| `WEBHOOK#/EVENT`               | Left alone. Expires on its own 30-day TTL                                      |
| `EMAIL_NORM#`, `ALLOWLIST#`    | Not reachable. See below                                                       |

On the billing row the scrub removes `paymentMethodId`, `paymentMethodLast4`, `paymentMethodBrand`, `paymentMethodExpMonth` and `paymentMethodExpYear`. `stripeCustomerId`, `subscriptionId` are system identifiers and stay, though the last of them then references an object Stripe deletes along with the customer.

Flagging the identity row rather than emptying it is a correctness requirement, not a matter of taste. Auth middleware branches on the row carrying both `userId` and `orgId`. A row stripped of them falls through to the new-user path, which mints fresh ids and then cancels its own transaction against the still-present key — a `500` on every login attempt instead of a clean refusal. Retaining the identifiers keeps that branch intact, so the explicit `deleted` check answers with a `410`.

Credentials are destroyed rather than retained, because a scrubbed credential row is still a credential row and retention buys nothing. The RAG key lookup row cannot be scrubbed at all: its delete path conditions on `orgId`, so stripping that attribute would block key deletion permanently. In `RagIndexerTable` the object keys and bucket names sit inside the primary keys, where attribute scrubbing is a structural no-op.

`EMAIL_NORM#` and `ALLOWLIST#` are keyed by a plaintext email address, and **the teardown neither scrubs nor deletes them**. This is not an omission, and it is not work the worker could pick up later. No row stores a user's email, so neither key can be reconstructed from the deletion record or from any retained row. The trial-entitlement row therefore keeps its `userId`, and the RAG allowlist row keeps granting access — its mere presence is the grant, and it has no attributes to strip.

Rekeying `EMAIL_NORM#` to a salted hash, under the same single-secret constraint as decision 6, is what removes this personal data. `ALLOWLIST#` needs the same treatment. Both should ship as **their own PR with a migration**, not inside the deletion work. The migration repoints the primary key of a live anti-abuse record whose writer claims it with `attribute_not_exists(pk)`, so a partial run either grants a second free trial or locks a legitimate user out of their first.

### 10. Observability

The teardown has no duration target, so the signal is not how long a deletion took but whether one has stopped making progress. Two EMF metrics in the `FilOne` namespace carry that, both emitted by the sweeper:

- `StuckAccountDeletionCount` — a dimensionless gauge of records past the staleness window, emitted on every run including when it is zero, so an alert on `> 0` auto-clears.
- `BlockedAccountDeletion` — emitted per org once a record passes ten attempts, with a paired `console.error` for Loki triage.

Both reach Grafana Cloud with no infrastructure change, since `FilOne` is already in the metric stream's include filter. The deletion worker's failed asynchronous invocations land in a dead-letter queue whose depth arrives the same way, `AWS/SQS` being in that filter too.

`BlockedAccountDeletion` carries an `orgId` dimension, which is the per-entity cardinality the [drift-telemetry ADR](2026-04-subscription-drift-telemetry.md) rules out. It is admitted here because the ten-attempt threshold makes it rare by construction: a deletion that reaches it is already an incident. This is a deliberate exception to a stated rule, not an oversight.

One gap remains. Nothing in this repository shows these metrics being alarmed on. There are no CloudWatch alarms and no SNS or paging integration anywhere in the codebase; alerting lives in Grafana Cloud and is configured by hand. `docs/SLOs.md`, named as the destination for panels and alerts by two existing metric ADRs, does not exist. So the metrics are real while the alert rules are unversioned and unreviewable. This predates the feature, but it is why a reader cannot confirm from the repository that a stalled deletion pages anyone.

## Consequences

### Accepted costs

| Cost                                                            | Reasoning                                                                                                                                                        |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Up to ~30 minutes before teardown starts, if the invoke is lost | Deletion need not be immediate. The fences already made the account inert.                                                                                       |
| The sweeper runs a full-table `Scan`                            | Fine at current table size. Revisit when RCUs or scan duration show up in cost or latency; the fix is a sparse GSI on an attribute present only while `PENDING`. |
| The confirm transaction caps at 97 members                      | See below.                                                                                                                                                       |
| Possibly up to 12 hours of unbilled storage per deleted org     | Only if the usage-reporting path proves too entangled to call directly. Bounded, and better than blocking the feature on that refactor.                          |
| Finalized invoices keep their `customer_email` snapshot         | They are immutable, and retained on the same legal-obligation basis as the rest of the financial record.                                                         |
| Deleted orgs keep a row in every partition they occupied        | The rows carry no personal data and no entitlement. Retention is what makes the guards in decision 5 cheap and the re-runs in decision 2 possible.               |

### The 97-member limit

`TransactWriteItems` accepts 100 items. The confirm transaction spends the code, writes the `DELETION` record, raises the profile fence, and then flags one identity row per member — so `3 + N ≤ 100` caps an org at 97 members. Scrubbing rather than creating tombstones does not change this: either way it is one write per member.

Past the limit the transaction is rejected as a whole. Nothing commits: no spent code, no `DELETION` record, no fence. The user gets a failed request against an account that has not been touched. It fails closed and leaves no partial state to recover from, which is the property that matters most here. `createNewUserAndOrg` is still the only writer of `MEMBER#` rows, so an org has one member today.

What is missing is a warning before we first reach the limit. That lands in the alerting gap described in decision 10 rather than in this design.

### Deferred risk

A tenant-setup request that read the profile before `deleting` landed can create an upstream tenant, then be refused when it records the id. The result is a tenant with no local pointer. The window is bounded by API Gateway's 29-second timeout.

Tenant setup should recover from this itself. When the conditional write is refused, it re-reads the profile with a consistent read. If the profile is deleting, it deletes the tenant it just created. If not, the refusal is an ordinary lost race and falls through to the existing handler. Telling the two apart requires the refused write to return the current item, which also stops the caller asserting on a tenant id nobody will ever write.

Aurora already makes that distinction and raises a distinct error for it. The generic orchestrator path lets the raw conditional-check failure become an indistinguishable `503`. Aligning them is part of this work.

Reconciliation against provider tenant lists is filed as its own ticket and remains the backstop for anything this recovery misses. Growing the worker to cover it would trade a bounded leak for permanent complexity in the teardown path.

## Open questions

None blocks the architecture. All three need a decision owner outside engineering.

| Item                                                              | Owner   | What is needed                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An uncollectable final invoice                                    | Finance | The teardown makes one best-effort charge attempt and leaves the invoice open when the card declines. Someone needs to confirm that is the intended outcome and own what happens to it afterwards, since the customer record is gone by then and the account cannot be dunned.                          |
| HubSpot retains the contact, with email and marketing preferences | Product | Delete the contact as a worker step, or document the retention as a lawful basis. As a step it inherits the same idempotency contract, where 404 counts as success.                                                                                                                                     |
| Duplicate Stripe customers                                        | —       | Largely answered by decision 3: retaining the billing row makes `createBillingTrial` a no-op, so the path that minted a second customer is closed. `create-setup-intent` can also create one, and is fenced. Worth confirming in practice that no duplicate customers exist for orgs already torn down. |

## References

- [Billing read model never synthesizes entitlement](2026-07-billing-read-model-never-synthesizes-entitlement.md) — why the `createBillingTrial` write cannot be conditional.
- [Observability architecture](2026-03-observability-architecture.md) — the EMF and metric-stream pipeline decision 10 relies on.
- [Subscription drift telemetry](2026-04-subscription-drift-telemetry.md) — the per-invocation metric pattern, and the cardinality rule decision 10 makes an exception to.
- [Synchronous tenant setup on first resource](2026-05-synchronous-tenant-setup-on-first-resource.md) — the stuck-gauge precedent.
- [Usage-based storage billing](2026-03-usage-based-storage-billing.md) — the meter aggregation that makes a repeated usage report safe.
