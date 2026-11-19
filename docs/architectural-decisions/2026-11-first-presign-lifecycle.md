# First platform object presign milestone (sc-455)

The staging lifecycle outbox now supports `presign.first_issued` for newly
instrumented signup cohorts. This records successful server generation through
`POST /api/presign`, not proof that the browser received or used the URLs. It
does not cover avatar/logo upload routes, direct SDK/client signing, or storage
provider signing. No signed URL, bucket/key, request body or actor is retained.
This is one lifecycle milestone, not the canceled raw presign-generation audit
log. The producer's existing `filone.identity` source emits this Organization
journey milestone only after its receiver allowlist is explicitly extended.

## Honest first-event scope

Existing Organizations are excluded: observing their next request cannot prove
that it was their first issuance. A captured signup transaction now writes
`lifecycleCaptureStartedAt` and, when separately configured,
`lifecycleCaptureEpoch` on the authoritative Organization profile alongside its
signup outbox record. Only Organizations enrolled at creation in the current
first-milestone epoch can emit this milestone. There is no historical backfill
or snapshot inference. Additional Organizations created manually or by invitation
are not silently enrolled by this signup-only slice.

`FILONE_LIFECYCLE_FIRST_MILESTONE_EPOCH` is absent by default, disabling this
milestone even when signup capture is on. An explicit opaque epoch requires
active staging lifecycle capture. Use a fresh, never-reused epoch for each
continuous activation period. After any capture gap, rollback, or deployment
that omits this instrumentation, retire the old epoch before reactivation.
Older cohorts are then excluded: a missed first issuance during a gap must not
be relabeled as a new first issuance. A deployment process cannot automatically
prove that no other signer ran; epoch continuity is an operational acceptance
prerequisite, not inferred from the absence of an event.

## Commit and identity rules

The existing request authorization, subscription checks, bucket-access checks,
tenant readiness and successful signing of the entire batch happen first. The
handler passes only its authenticated Organization ID, trusted orchestrator ID,
Observed Tenant ID and already-loaded authoritative profile to the lifecycle
writer. The outbox detail contains these opaque correlation IDs, the occurrence
timestamp, event type/schema and a deterministic Organization/event-type ID.

A DynamoDB transaction joins the permanent first marker on the Organization
profile to the immutable outbox row. Its condition rechecks the exact capture
start/epoch, provider tenant mapping, existing profile and absence of the deletion
fence. A stale profile cannot write onto a newly mapped/deleting Organization.
The first marker outlives the 180-day outbox TTL, so expiry cannot manufacture a
second first. The normal already-enrolled request reuses the profile read that
presign already performs; once its first marker is visible, it adds no database
read or write. Before that marker, the canary's first issuance requires one
transaction, and a commit failure prevents returning the generated batch.

Concurrent first issuances across regions/providers have one deterministic
global Organization milestone. A conditional loser accepts only a prior first
marker with the same event identity, capture start/epoch and caller's current
provider mapping, and no deletion fence. It does not overwrite the winning
event's occurrence or mapping. Other cancellation/transport errors are sanitized
and fail the canary request. A missing response after a committed transaction
does not create a second milestone on retry.

Provider identifiers come from the platform registry/profile attributes
(`aurora`, `fth`, `forge`, `forgeDev`), not browser input. The first event links
the provider on which the first supported issuance occurred; it is not a list
of every tenant provisioned for that Organization. Forge audit-bus onboarding
and correspondence to its future S3 envelope Source require separate provider
contract acceptance. This mapping does not authorize a restriction.

## Activation and acceptance still required

Keep provisioning/capture/first-milestone flags off until the staging plan and
producer roles are reviewed. Before activating this code, allow this exact
publisher role/source to emit both `organization.signup` and
`presign.first_issued` in the broker lifecycle receiver. A role that may only emit
signup will correctly reject the new milestone; its durable failure is not
accepted delivery. The publisher itself permits only these two reviewed event
types and their type-specific fields.

Start a fresh reviewed epoch with a new disposable signup, verify the signup
profile/outbox cohort markers and authoritative provider ID, then sign a
harmless object through the normal API. Verify one broker event under both the
Organization timeline and the exact Observed Tenant index. Repeat the request,
simulate a lost response, race two first issuances and force an outbox failure.
Verify stable identity, no duplicate first event, recovery and clean failure
without a partially committed marker. A non-enrolled Organization must emit
no fabricated first milestone. An Organization from a retired epoch must stay
excluded after reactivation. Retain aggregate-only evidence.

Local tests prove source-level transaction/fence/order behavior. They do not
prove live IAM/KMS/delivery, complete signup instrumentation, epoch continuity
or platform-wide signing coverage. Trial, first bucket, payment and restriction
outcome producers, broader signup metadata, all-provider mapping, and integrated
operator acceptance remain required before sc-455/sc-453 are complete.
