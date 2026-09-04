# ADR: Explicit permission grants for organization members (IAM M2, FIL-1019)

**Status:** Draft (design exploration, awaiting acceptance)
**Created:** 2026-08-27
**Builds on:** [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md)

## Context

Recently we added [organizational roles](./2026-08-organizations-roles-m1.md) and
a way for users to assume one of them. These roles carry predefined permissions,
and today there is no way to extend a role past its definition.

An example of a permission we would want to grant explicitly is deleting an
object in a bucket with governance-mode retention enabled.

This ADR proposes a design for granting an explicit permission to an
organization member, and proposes the first such grant: permission to delete
objects in buckets with governance-mode retention enabled.

## Decision

We add a mechanism for granting one named permission to one organization
member, and `retention.override` as its first grant.

### The grant mechanism

A grant is a named permission held by a member, separate from the member's
role. Grant names live in the registry vocabulary alongside role permissions.
The [roles ADR](./2026-08-organizations-roles-m1.md) already put
`privileged.grant` there and gave it to Owners alone, describing it as the right
to give another member a privileged operation. No privileged operation was ever
defined, so that permission does nothing today. The granting authority needs
nothing new. What we need is a record of who holds what, a way to edit it, and
an audit trail.

Grant names are open-ended. This ADR adds one, and the table, the editor, the
holder list and the granted and revoked events serve any grant we add later.

### Where grants are stored

Grants go in a new `PermissionGrantTable`, two rows per grant written in one
`TransactWriteItems`, the way the
[roles ADR](./2026-08-organizations-roles-m1.md) keeps a membership row and its
inverse item consistent.

| pk                              | sk                  | Attributes               | Purpose                             |
| ------------------------------- | ------------------- | ------------------------ | ----------------------------------- |
| `ORG#{orgId}#MEMBER#{userId}`   | `GRANT#{grantName}` | `grantedBy`, `grantedAt` | A member's grants are one partition |
| `ORG#{orgId}#GRANT#{grantName}` | `MEMBER#{userId}`   | `grantedBy`, `grantedAt` | The holder list for one grant       |

The table is new. The `BucketAccessTable` from the
[member bucket scope ADR](./2026-08-member-bucket-scope-m2.md) has
`{region}/{bucketName}` as its sort key and is designed to hold one subject. A
partition of `OrgTable` is ruled out because `ORG#{orgId}` is the partition
every authenticated request already reads.

An Owner holds every grant by role and gets no row, so nobody can take an
Owner's holding away one row at a time and an org cannot end up with nobody able
to restore a grant. Everyone else holds grants by row:

- A row records a grant to a member who is not an Owner.
- Only an Owner can write or delete a row, because that requires
  `privileged.grant`.
- A holder who is not an Owner cannot pass a grant on, because a grant row does
  not carry `privileged.grant`.
- Any role can receive a grant, since the person doing this work sits at
  whatever role the org gave them.

Resolving a grant costs one `GetItem` on `ORG#{orgId}#MEMBER#{userId}` /
`GRANT#{grantName}`, with `ConsistentRead`, because an access-control read must
not see a stale replica. `org-membership.ts` reads the role the same way. The
read runs only when a caller who is not an Owner asks for a privileged
operation, so ordinary requests do not pay for it.

### The first grant: `retention.override`

`retention.override` permits signing a presigned delete that carries the
governance-bypass header. The grant covers one action on one named object, and
we record the object's retention state as we sign, so every use of it appears in
the audit log with what it overrode.

Any future presign that weakens a lock falls under the same grant. The route
manifest says a presign mutating retention or legal hold "is redeemed at the
vendor where its use cannot be logged, so if one is ever added it must be gated
on an explicit privileged grant rather than on a general object permission"
(`packages/shared/src/route-manifest.ts:152-156`).

Minting an access key that carries `PutObjectRetention` or
`PutObjectLegalHold` is a different kind of permission and is not part of this
ADR. Such a key weakens locks at the Service Orchestrator for as long as it
lives, no console request is involved in any use of it, and whoever ends up
holding the key need not be the person we granted it to. The
[roles ADR](./2026-08-organizations-roles-m1.md) already requires
`privileged.grant` to mint such a key, a blanket rule that gives that capability
to every Owner and to nobody else. FIL-1019 asks for explicit per-operation
grants in place of blanket elevation, and that rule stays as it is until we take
the question up on its own (see [Options considered](#options-considered)).

#### How object locks work today

Three things can stop an object from being deleted, and each one is lifted
differently.

| Mechanism            | How it is lifted                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Governance retention | `s3:BypassGovernanceRetention` on the credential and `x-amz-bypass-governance-retention: true` on the request. Missing either one answers `AccessDenied`. Extending the date needs only `s3:PutObjectRetention`. |
| Compliance retention | Nothing lifts it at any permission level. The object survives until its date passes.                                                                                                                             |
| Legal hold           | `PutObjectLegalHold` with the status off. There is no bypass action and no header.                                                                                                                               |

No Service Orchestrator we integrate with accepts
`s3:BypassGovernanceRetention` today. The Management API's
`AccessKeyPermission` enum carries fifteen actions and no bypass action
(`docs/service-orchestrator-integration/management-openapi.yaml:532-549`). FTH's
action maps (`FTH_BASE_PERMISSIONS`, `FTH_GRANULAR_PERMISSIONS`) have none.
Aurora's portal takes coarse access types, and none of the documented types
covers it. No key we mint or hold can override a governance lock, including the
per-tenant `filone-console` key.

A member who tries to delete a locked object through the console gets a refusal
that does not say why.

- A presigned `deleteObject` is refused at the Service Orchestrator with a 403.
  The console signs the URL and never learns what happened to it.
- Bulk delete records the locked keys as per-object failures, moves its cursor
  past them, and finishes with those failures listed.
- `DELETE /api/buckets/{name}` answers 409 `BUCKET_NOT_EMPTY`, because a locked
  object keeps the bucket non-empty.

Account and org teardown runs on the Service Orchestrators, which sequence
deletion themselves, so the console is not involved.

### Overriding a governance lock

A new presign operation, `deleteObjectBypassingGovernance`, signs a
`DeleteObject` with `x-amz-bypass-governance-retention: true` in
`SignedHeaders`, under the tenant's `filone-console` credential, expiring in the
standard 300 seconds (`PRESIGN_EXPIRY_SECONDS`). Ordinary deletion stays on
`deleteObject` and does not change.

This is its own operation. The handler already branches per operation, and the
route manifest documents the mapping operation by operation.

`deleteObjectBypassingGovernance` may not appear in a batch. `/api/presign`
rejects a batch whole if any operation in it is denied, and keeping this
operation out of batches holds one signing to one audit event.

Before signing, the handler reads the object's retention and writes the audit
event from what comes back. If the read fails we refuse to sign, because
without it the event cannot say what was overridden.

The Service Orchestrator redeems the URL. Within those 300 seconds a holder can
redeem it any number of times, or not at all, and we see none of that. A
server-side delete would show us the outcome, and we gave that up to keep object
deletion on the one path it already uses (see
[Options considered](#options-considered)).

### Audit events

We add `permission_grant.granted`, `permission_grant.revoked`, and
`retention_override.signed`.

The first two carry the grant name, so they serve every grant we add later.
They join the `TransactWriteItems` that writes or deletes the grant rows, the
way `commitAudited` handles a mutation that is ours alone, so a grant cannot
land unrecorded.

`retention_override.signed` records the actor, region, bucket, key, version,
and the retention mode and retain-until date read from the object at signing
time. The event means we signed a URL. A URL nobody redeems still produces one
event, and a URL redeemed four times still produces one event. Reading the
retention first costs a call the presign path does not make today, and it is
the only chance we get: after the delete there is nothing left to show what was
overridden.

FIL-1019 asks that every grant, revocation and use be audit-logged. We can log
grants and revocations for any grant. We cannot log use of
`retention.override`, and no design within the console's reach can: the Service
Orchestrator performs the delete under the tenant's console credential, and no
Service Orchestrator reports object deletions back to us. An object-level
deletion feed would close this, and it is the same ask as the bucket-lifecycle
feed in
[`2026-08-member-bucket-scope-m2.md`](./2026-08-member-bucket-scope-m2.md).

We do not log denials. One event per refusal turns the audit log into a traffic
log, and request-level logging is FIL-949.

### Compliance retention and legal holds

No grant reaches an object under compliance retention, and none ever will. S3
gives compliance mode no override at any permission level, and the object
survives until its date passes. `retention.override` covers governance mode,
the lock a customer chose knowing it could be lifted.

The console says which refusal the caller is looking at. Someone who overrode a
governance lock a minute ago and is then refused on a compliance-locked object
will read the refusal as a bug, and an `AccessDenied` from the Service
Orchestrator explains nothing.

- Compliance retention: the object cannot be deleted before its date, by
  anyone.
- Governance retention, in a region without the capability: this region cannot
  override a governance lock yet.
- Governance retention, no grant: the caller does not hold
  `retention.override`.
- Legal hold: no console operation can clear a hold.

The legal-hold gap is real. Clearing a hold requires `PutObjectLegalHold`, and
no presign operation mutates a legal hold. If we add one it falls under
`retention.override`.

### Rollout

The mechanism and one grant go out together, and nobody can exercise the grant
yet. No Service Orchestrator carries the bypass action, so the override will
report unavailable in every region on release. We do it anyway: an org can
decide who would hold `retention.override` before anyone can exercise it, the
log carries those decisions from the first day, and the mechanism is in place
for the grants that follow.

The first release contains:

- The `PermissionGrantTable`, with point-in-time recovery the way `OrgTable`
  has it, and an IAM policy narrowed to the operations the handlers perform.
- Account-deletion teardown and `deletion-scrub.ts` wired to the table in the
  same PR that creates it, before any row exists.
- `retention.override` in the registry vocabulary, the grant editor, the holder
  list, and all three events.
- The presign operation, answering with the region-capability refusal above, so
  the console never offers a button that returns 403.

The contract change is one request to both Service Orchestrators and to the
Management API spec they implement. The spec gains
`s3:BypassGovernanceRetention` in `AccessKeyPermission`, FTH gains it in its
action vocabulary, and Aurora gains an access type for it. We send it with the
bucket-lifecycle-feed ask from the
[member bucket scope ADR](./2026-08-member-bucket-scope-m2.md).

Grant management goes on the members page next to the role editor, where an
Owner already goes to change what somebody can do and where the bucket-scope
editor lands. The console offers the override on an object only after a delete
has been refused for a governance lock. That keeps the override a deliberate
act, and it keeps a second button off every locked object. Both surfaces sit
behind
the `ORGS_BETA` row pattern (`lib/orgs-beta.ts`), so we can turn them on per
org with a row.

## Options considered

**A server-side override delete.** A handler performing `DeleteObject` with the
bypass header under the console credential is the one design where we see the
outcome and can write an event meaning the object is gone. We gave that up to
keep object deletion on the path it already uses: `presign.ts` is the whole of
object deletion in this product, and a second deletion path needs its own error
vocabulary, its own tests and its own answer for versioned objects. The
object-level deletion feed closes the same audit gap for every path at once.

**Adding a grant for access-key minting in this ADR.** The
[roles ADR](./2026-08-organizations-roles-m1.md) requires `privileged.grant` to
mint a key carrying `PutObjectRetention` or `PutObjectLegalHold`, and FIL-1019
wants that replaced with an explicit grant. The two permissions answer different
questions, so the key-minting grant waits. `retention.override` authorizes one
action that we sign and log; a key is a standing capability with no console
record of any use, and who may create one deserves its own argument. When we
take it up, the rule should keep covering both permissions. Narrowing it to
`PutObjectLegalHold`, on the ground that no credential can weaken a retention
while no credential holds a bypass action,
breaks the day someone puts the bypass action on a console key to unblock a
support case.

**A grant per lock mechanism.** Matches S3's vocabulary, and produces three
grants: one nobody can exercise, because compliance mode has no override; one
that duplicates an ordinary object write, because clearing a legal hold is a
`PutObjectLegalHold` call; and one naming an action no Service Orchestrator
accepts. Naming the grant for what it does to a lock gives us one grant that
covers every presign we might add.

## Open questions

1. **Which Service Orchestrator adds the action first.** Both need the same
   change request and neither has committed. Aurora's is the larger, because its
   portal takes coarse access types and has no per-action vocabulary to extend.
   Until one arrives, `retention.override` is a grant an org can hand out and
   nobody can use.
2. **Whether bulk delete gains an override.** Emptying a bucket that will not
   delete is the realistic reason to want this. Refusing it means a grant holder
   clicks through a bucket one object at a time, which tells the audit log less
   than one job with a stated scope would. This is a business decision before it
   is a design one. If we do it, the job takes one event when it is created,
   covering its scope.
3. **What a customer key can do to a lock at each Service Orchestrator.**
   Unmeasured. Nobody has run whether a key carrying `PutObjectRetention` can
   shorten a governance retention without a bypass action. The answer decides
   how urgent the access-key rule is. A one-bucket probe per Service
   Orchestrator would settle it.

## References

- Tickets: FIL-1019 privileged operations, FIL-1015 roles and the permission
  registry, FIL-1017 member bucket scope, FIL-1020 legacy key transition,
  FIL-1022 audit viewer, FIL-1024 per-region disclosure, FIL-949 request-level
  logging.
- [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md) for
  the permission registry, `privileged.grant`, the key-permission cap, and the
  audit write path this design extends.
- [`2026-08-member-bucket-scope-m2.md`](./2026-08-member-bucket-scope-m2.md) for
  the bucket-lifecycle feed our Service Orchestrator ask travels with.
- [`2026-04-service-orchestrator-management-api.md`](./2026-04-service-orchestrator-management-api.md)
  for the Management API contract the bypass action has to enter.
- `packages/shared/src/route-manifest.ts:152-156` for the rule about presigns
  that mutate retention or legal hold.
