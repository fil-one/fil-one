# Verified billing outcomes for Audit Broker (sc-455)

This staging-only, default-off producer captures `trial.started`,
`payment.succeeded` and `payment.failed` from the original signature-verified
Stripe events already retained in the platform FIFO queue. It does not derive
events from current billing/Stripe snapshots or from the absence of records.

The worker performs its existing business processing, commits the small
lifecycle outbox record, and only then writes its handled receipt and returns
success. If the outbox is unavailable, the worker throws a sanitized error and
the existing queue retains/retries the original event. This remains true when
business processing committed before a lost response or now legitimately
returns early: lifecycle capture still receives the original queued event.
The two stores are not one transaction; the durable original FIFO event is the
retry boundary. The existing bounded queue retries and restricted DLQ remain
required acceptance evidence.
Terminal payment/recovery metrics are deferred until lifecycle capture succeeds,
so an outbox failure does not double-count them on the queue's next attempt.
This does not make metrics globally exactly once: the queue retains its existing
at-least-once delivery and later acknowledgment failure behavior.

## Original evidence and payment semantics

- `trial.started` requires an original `customer.subscription.created` snapshot
  whose status is `trialing` and whose `trial_start` is a valid timestamp. Its
  occurrence comes from that original trial start, even if delivery is delayed
  and the subscription has since changed. An ordinary paid subscription is not
  silently called a trial.
- `payment.succeeded` requires an original `invoice.payment_succeeded` event,
  invoice status `paid`, and a positive safe-integer `amount_paid` in minor
  currency units. A zero/free trial invoice, fractional/invalid amount or an
  open invoice is not evidence of actual payment.
- `payment.failed` requires an original `invoice.payment_failed` event with a
  positive safe-integer amount due. Each real failure event has its own stable
  replay identity; an ordinary customer update does not become a failure.

The authoritative Organization identifier must be present in the original
subscription metadata or the invoice's original metadata/subscription metadata
snapshot. Both the current `parent.subscription_details.metadata` shape and
the older `subscription_details.metadata` shape are supported. Conflicting
identifiers fail closed rather than selecting an arbitrary candidate. Stripe
documents the finalized invoice's subscription metadata as an
[immutable snapshot](https://docs.stripe.com/api/invoices/object).
No lookup of a currently mutable Customer is used to invent a historical link.
When capture is active, an eligible event without an opaque unambiguous
Organization is retried into the existing DLQ for authoritative repair.

Only schema/event type, opaque Organization ID, original occurrence time and
a SHA-256-derived event ID enter the outbox. Event identity derives from the
original Stripe event ID, not the worker invocation or receipt time. Amounts,
currency, customer/subscription/invoice/payment-method IDs, card fingerprints,
card/contact data and original event bodies are not copied. A payload digest
guards against the same replay ID being reused with different content.
Identical retries may renew the 180-day outbox TTL but cannot replace the
recorded payload; MODIFY stream records do not publish a second event.

## Separate producer authority

Billing uses its own `BillingLifecycleOutbox`, dedicated publisher role and
`filone.billing` source. Its PutItem writer link is attached only to the Stripe
worker, not to all application routes. The identity publisher still has only
its own stream and `filone.identity` PutEvents authority. The shared runtime
uses a fixed source-to-event-type map; identity events cannot be emitted by the
billing role and billing events cannot be emitted by the identity role.

The receiver's `lifecycle_producers` must bind the distinct role output
`billingLifecycleProducerRoleArn` to `filone.billing` with only these three
event types. Existing identity producer permissions must not be widened to
impersonate billing. Each publisher has its own encrypted, private 14-day
failed-batch archive and its own stream and source-scoped aggregate alarms.
The billing publisher never receives the original Stripe queue or billing-table
contents. Both outboxes retain PITR, managed encryption and deletion protection.
While billing resources are provisioned, worker Errors and the existing Stripe
source DLQ also alarm to the reviewed topic. These include unrelated business
processing failures: an outbox write that never reaches the publisher must not
remain invisible behind publisher-only health metrics.

The common delivery factory preserves all existing identity publisher logical
resource names. It adds a static Producer metric dimension to distinguish
failures; no Organization or payment identifier is a metric dimension.

## Staging activation and live acceptance

1. Keep `FILONE_LIFECYCLE_BILLING_PUBLISHER_ENABLED` and
   `FILONE_LIFECYCLE_BILLING_CAPTURE_ENABLED` absent/false by default. Billing
   provisioning requires the existing reviewed staging lifecycle publisher
   configuration, including its alarm topic. Production/local/ephemeral
   activation remains rejected. Billing capture requires its provisioned
   dedicated publisher, independently of signup capture.
2. Provision the billing outbox/publisher with capture still off. Record the
   dedicated role output and review the exact source binding, event allowlist,
   KMS/stream and failure-archive permissions. Configure and verify the broker
   receiver before capture is enabled. No provider event subscriptions are
   changed by this source implementation.
3. Enable billing capture only after reviewing the eligible Stripe event
   population and missing-metadata failure behavior. With disposable staging
   fixtures, deliver a signed original trial event, positive paid invoice and
   failed payment; verify one event per original ID in the broker Organization
   timeline. A free trial invoice must not look paid. Retain aggregate-only
   evidence rather than raw billing objects.
4. Force outbox failure after successful business processing. Verify the
   original FIFO message retries and no handled receipt acknowledges it before
   durable capture. Retry the same event, then attempt a conflicting payload
   under its ID. Verify stable identity, immutable payload, alarms, delivery
   failure archive and authoritative metadata repair/redrive without fabricating
   a newer occurrence timestamp.
5. Roll back capture by removing only its capture flag, retaining the durable
   resources and producer while draining/reviewing outstanding records.
   Removing provisioning flags is not a safe data rollback: those resources
   are deletion-protected and failure archives refuse forced destruction.

## Remaining payment-method and sc-455 gaps

The [attachment follow-on](2026-11-payment-method-lifecycle.md) now implements a
default-off immutable Customer binding and exact `payment_method.attached`
adapter, with explicit staging-only provider configuration. Its live activation,
delivery and cohort coverage remain unverified. The earlier implementation
boundary below explains why current snapshots were insufficient.

`payment.method_added` is not inferred from `customer.updated`: that event may
merely include a previously saved default method. The current endpoint does
not subscribe to `payment_method.attached` or `setup_intent.succeeded`, and
current SetupIntent/PaymentMethod objects do not carry the trusted Organization
metadata this original-event producer needs. A safe follow-on requires a
durable authoritative customer/Organization binding or explicitly recorded
producer metadata, original attachment/confirmation handling and reviewed
webhook-subscription activation. No Stripe admin/setup Version change is made
here. This is an explicit remaining acceptance gap, not a completed milestone.

Local unit tests verify parsing, privacy, source separation, worker ordering and
retry behavior with mocked boundaries. They do not prove live signatures,
queue/DLQ delivery, IAM/KMS, retention or billing-source authorization. Those
checks, payment-method capture, first-bucket and restriction/restoration
producers, broader signup metadata and integrated operator acceptance remain
required before sc-455/sc-453 can close.
