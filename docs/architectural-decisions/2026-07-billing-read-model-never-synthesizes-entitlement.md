# ADR: The billing read endpoint must never synthesize entitlement

**Status:** Accepted
**Created:** 2026-07-30

## Context

A production report — "`/buckets` returns HTML instead of JSON" — traced to `GET /api/billing`
fabricating a subscription that did not exist. The guard (`subscription-guard.ts`) correctly
denied a re-signup under the one-trial-per-normalized-email rule (403 `SUBSCRIPTION_INACTIVE`),
while `get-billing.ts` simultaneously reported a healthy free trial with a `trialEndsAt` date it
invented per request. The console therefore showed "Free trial · N days remaining" to a user whose
every guarded request was being rejected, with no badge, no CTA, and no way to pay.

The fabrication dated from the original billing implementation, when "no billing record" really
did mean "new user on a trial". The email-entitlement gate (#422) invalidated that assumption and
never revisited the read path. A production audit found the same function also misreporting 254
records that carry a real stored status (`active`, `past_due`, `grace_period`, `trialing`) but no
`stripeCustomerId` — all rendered as "free trial, trialing".

## Decision

`GET /api/billing` is a **read model**. It grants nothing and it never reports entitlement the
guard would deny. Two supporting rules:

1. **The endpoint reports the stored `subscriptionStatus` verbatim** and never substitutes a
   default. A record with a status but no Stripe customer reports that status (with the cached
   payment method and no Stripe call) — not a hardcoded trial.
2. **An absent status means _not entitled_, matching the guard.** No billing record, or a record
   without `subscriptionStatus` (e.g. the customer mapping `create-setup-intent` intentionally
   writes), is reported as `{subscription: {planId: 'none', status: 'inactive'}}` — the standard
   `BillingInfo` envelope, so a cached `paymentMethod` still accompanies it. No `trialEndsAt`, no
   Stripe call, no DynamoDB write.

`SubscriptionStatus.Inactive` and `PlanId.None` are **read-model values only**: never persisted,
never returned by `mapStripeStatus`. The guard blocks `inactive` explicitly (it already failed
closed; the branch states the contract). This follows the repo's precedent for "resource absent"
responses (`bucket-rag-enablement.ts` reports `status: 'disabled'` with defaults rather than 404).

The frontend ships with the backend: the console shows "No active plan" with a "Choose a plan" CTA
that goes through a fresh SetupIntent (`canReactivateWithSavedCard` stays false for `inactive`, so
the saved-card path — which the backend rejects for statusless records — is never offered).

### Rejected: reporting `canceled` instead of a new status

Reusing `canceled` would have needed zero frontend changes, but `get-billing` returns a cached card
for statusless records, so the console would offer "Reactivate with saved card" —
`activate-subscription` then returns 400 because DynamoDB has no status. That reintroduces the
defect being fixed: a response that disagrees with the endpoint acting on it.

## The `createBillingTrial` write-ordering hazard

The audit's root cause for the 254 status-without-customer records: `create-billing-trial.ts` did
GetItem → `customers.create` → `subscriptions.create` → **conditional PutItem last**
(`attribute_not_exists(pk)`). Stripe fires `customer.subscription.created` as soon as the
subscription exists; when that webhook won the race it upserted a partial record (status +
`subscriptionId`, no customer mapping), the conditional put silently no-oped, and
`stripeCustomerId` was never stored. Those users work until they try to pay, where
`activate-subscription` returns 400 "No Stripe customer found".

The final write is therefore an **unconditional `UpdateItem`** that sets `stripeCustomerId`,
`subscriptionId`, `orgId`, and the trial fields, with
`subscriptionStatus = if_not_exists(subscriptionStatus, :trialing)` so a fresher webhook-written
status is never clobbered. **Do not reintroduce a conditional write here** — any write that can
silently lose the Stripe customer mapping recreates the orphan cohort.

Relatedly, the webhook writers now backfill `orgId = if_not_exists(orgId, :orgId)` from Stripe
metadata: records without an `orgId` are skipped by all three lifecycle jobs (usage reporting,
drift checking, grace enforcement), which is how the orphan cohort stayed invisible for four
months.
