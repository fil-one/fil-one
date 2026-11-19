# Exact payment-method attachment outcomes (sc-455)

This opt-in staging slice captures the original `payment_method.attached` event
as `payment.method_added`. It does not substitute `setup_intent.succeeded`:
successful setup can reuse an already-attached method without a new attachment.
No SetupIntent success subscription or client-secret queue retention is added.
An attachment is not evidence of a successful payment or a distinct new card.

## Establish the binding before a confirmable setup exists

With customer bindings enabled, the authenticated billing-management route
commits a Customer-to-Organization binding before calling
`stripe.setupIntents.create` or returning its client secret. A transaction checks
the existing billing row's exact current Customer and absence of its scrub fence,
checks the Organization profile exists and is not deleting, and conditionally
updates the separate binding table. A concurrent customer-map change, deletion
or conflicting immutable binding fails the request before a confirmable
SetupIntent is created.

The binding key is a versioned SHA-256 digest of the opaque Customer ID; no raw
Customer ID, card/method identifier, actor, contact or credential is stored in
this table. The value holds only the opaque Organization, first binding epoch
and 180-day expiry. The Organization and first timestamp use `if_not_exists`;
only the same Organization may renew expiry. This is a privileged correlation
record, not anonymization. There is no mutable Stripe Customer snapshot lookup.

`BillingLifecycleBindings` has managed encryption, PITR and deletion protection.
Only the setup-intent route receives its new UpdateItem link; only the Stripe
worker receives its new GetItem link. Existing billing/profile permissions
support transaction conditions but are not broadened for operator surfaces.
The identity/billing publishers receive neither these bindings nor its raw
Customer references. Their existing dedicated source authority stays separate.

## Original event resolution and coverage

The worker resolves the original verified attachment's Customer digest with a
strong exact-key read. It accepts only an unexpired, structurally valid binding
whose first epoch does not follow the original event's occurrence. A binding
recreated after an old event cannot silently assign that event to a new owner.
The actual source boundary is the successful binding commit before the new
SetupIntent call. Wall-clock comparisons have whole-second precision and are
an additional check, not a high-resolution cross-service ordering proof.

The lifecycle detail retains only schema, event type, opaque Organization/event
IDs and the original Stripe event time. Replay identity and payload protection
reuse the dedicated billing outbox. Raw Customer/method IDs, fingerprints,
card/contact data, event bodies and client secrets are never copied there.
Free-form PaymentMethod metadata cannot override the authoritative binding.

An account-wide Stripe subscription also receives attachments from outside the
instrumented setup flow. A missing, expired, pre-binding or unsupported Customer
reference therefore records a bounded `LifecycleAttachmentCoverageGap` reason
and skips attribution without stalling unrelated billing in that FIFO customer
group. These mean **outside-or-unknown coverage**, not a claim that every missing
binding was intentionally excluded. Binding read outages and corrupt records
remain retryable failures; they must not be disguised as an unbound customer.
No fallback scans or current-snapshot inference are used.

The table's deletion protection/PITR, write-only route grant and lack of app
DeleteItem grants preserve enrolled mappings; TTL removal after the covered
retention window is expected. Coverage-gap counters alone cannot establish a
complete cohort. Controlled fixtures must verify the expected binding and its
event, and operational recovery must reconcile authoritative records rather
than fabricate a historical binding after a missing event.

## Default-off rollout and persistent configuration

The normal staging deployment now explicitly reads reviewed GitHub **staging
environment variables** for the existing lifecycle publisher/capture, billing
publisher/capture, alarm topic and first-milestone epoch, plus these two inputs:

- `FILONE_LIFECYCLE_CUSTOMER_BINDINGS_ENABLED` provisions the separate table,
  route writer and worker reader. It requires the staging billing publisher.
- `FILONE_LIFECYCLE_METHOD_EVENTS_ENABLED` adds only
  `payment_method.attached` to the existing Stripe endpoint. It requires bindings
  and staging. A conditional `LifecyclePaymentMethodEvents` custom-resource
  property causes the reviewed setup update only when this flag is enabled.
  The ordinary SetupStack Version remains `2.13`; with the flag off, no provider
  subscription update is requested by this source change. The runtime also
  rejects non-staging activation before old-URL teardown or provider calls.

All booleans default false. No variables are set by this PR. Production has no
activation inputs, and SST rejects production/local/ephemeral provisioning.
Persist reviewed activation in the staging environment configuration before
deployment; a one-off shell flag would disappear on the next normal CI deploy
and request removal of protected resources. Retain provisioning flags during a
capture rollback instead of requesting data destruction.

First deploy bindings without the provider-event flag, verify the new route
commits mappings before setup and the worker's exact read permissions, then
review the distinct billing source's receiver allowlist including
`payment.method_added`. Only then explicitly enable the provider-event flag and
billing capture with agreed disposable staging fixtures. The source flag change
is a real Stripe configuration operation through the existing setup role; it
requires its concrete staging plan and review of the exact provider scope. It is not performed
by merging this default-off source.

Verify a new attachment, identical replay, conflicting immutable Organization,
unbound customer, expired/recreated binding, unavailable read, failed binding
write and a refused current-Customer/deletion condition. A failed binding must
create no confirmable SetupIntent. A successfully reused setup must produce no
attachment event unless Stripe emitted an actual attachment. Inspect aggregate
coverage/failure counts and broker timelines without retaining raw billing
payloads in ticket evidence.

This closes the source-level attachment implementation gap, not live sc-455
acceptance. Provider activation, IAM/KMS, signature/queue/DLQ delivery, replay,
retention, cohort completeness and integrated operator acceptance remain open,
as do first-bucket and restriction/restoration outcome producers.
