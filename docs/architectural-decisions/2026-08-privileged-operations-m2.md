# ADR: Overriding governance retention needs an explicit grant (IAM M2, FIL-1019)

**Status:** Draft (design exploration, awaiting acceptance)
**Created:** 2026-08-27
**Builds on:** [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md)

## Context

A customer who picks governance-mode retention over compliance mode chooses a
lock that an authorized person can lift before its date. FilOne cannot name that
person. The permission registry attaches a capability to a role, and an org that
wants one named individual to hold this one has no way to say so.

Three mechanisms hold an object down, and they answer to different authority:

| Mechanism            | What weakens it                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Governance retention | `s3:BypassGovernanceRetention` on the credential and `x-amz-bypass-governance-retention: true` on the request. Missing either answers `AccessDenied`. Extending the date needs only `s3:PutObjectRetention`. |
| Compliance retention | Nothing weakens it at any permission level. The object survives until its date passes.                                                                                                                      |
| Legal hold           | `PutObjectLegalHold` with the status off. No bypass action, no header.                                                                                                                                      |

`s3:BypassGovernanceRetention` appears in no contract FilOne talks to. The
Management API's `AccessKeyPermission` union carries fifteen actions and no
bypass, FTH's action maps (`FTH_BASE_PERMISSIONS`, `FTH_GRANULAR_PERMISSIONS`)
have none, and Aurora's portal takes coarse access types whose documented list
has none. No key FilOne mints or holds can override a governance lock, the
per-tenant `filone-console` key included.

Four console-mediated operations refuse a locked object today, and none of them
explains why:

- A presigned `deleteObject` is refused at the vendor with a 403. The console
  signed a URL and learns nothing about the redemption.
- Bulk delete records the locked keys as per-object failures and steps its cursor
  past them, finishing with those failures listed.
- `DELETE /api/buckets/{name}` answers 409 `BUCKET_NOT_EMPTY`, because a locked
  object keeps the bucket non-empty.
- Account and org teardown runs on the orchestrators' side, which sequence it
  themselves.

M1 recorded the shape of the answer twice. `privileged.grant` sits in the
permission registry held by Owners alone, described there as the right to grant a
privileged operation rather than as a privileged operation. And the route
manifest states that a presign mutating retention or legal hold "is redeemed at
the vendor where its use cannot be logged, so if one is ever added it must be
gated on an explicit privileged grant rather than on a general object permission"
(`packages/shared/src/route-manifest.ts:124-128`). M1 then shipped a blanket
form: minting an access key carrying `PutObjectRetention` or `PutObjectLegalHold`
requires `privileged.grant`, which puts both capabilities in the hands of every
Owner and nobody else. M1 named this ticket as what replaces that blanket
elevation with explicit per-operation grants.

## Decision

Six decisions shape this design.

1. **Two grants, defined by what they weaken**, rather than one grant per lock
   mechanism ([§1](#1-two-grants-defined-by-what-they-weaken)).
2. **Grants get their own table**, which holds a row only for a member who is not
   an Owner ([§2](#2-where-a-grant-lives)).
3. **The override rides on a presigned delete** carrying the bypass header,
   offered as a distinct presign operation
   ([§3](#3-the-override-rides-on-a-presigned-delete)).
4. **Three events, one of which cannot mean what the ticket asks**
   ([§4](#4-three-events-and-the-one-that-cannot-be-written)).
5. **Compliance retention is beyond every grant**, and the console names which
   refusal a caller is looking at
   ([§5](#5-compliance-retention-is-beyond-every-grant)).
6. **The grants ship before the capability exists**, with the override reporting
   unavailable in every region
   ([§6](#6-rollout-the-grants-ship-before-the-capability)).

### 1. Two grants, defined by what they weaken

A grant is defined by its effect on a lock rather than by the vendor mechanism it
rides. Defining one grant per mechanism would produce a compliance grant nobody
can exercise, a legal-hold grant that duplicates an ordinary object write, and a
governance grant naming an action no contract carries.

Two grants, because an Owner is handing over two different things:

| Grant                    | What it permits                                                                                                      | What the log holds                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `retention.override`     | signing a presigned delete that carries the governance-bypass header, and any future presign that would weaken a lock | one event per signing, with the object's retention state |
| `retention.key_mutation` | minting an access key carrying `PutObjectRetention` or `PutObjectLegalHold`                                          | the `key.created` event M1 already writes                |

`retention.override` authorizes one act on one named object, and the object's
retention state is captured as the signing happens. `retention.key_mutation`
hands over a standing capability: the key weakens locks at the vendor for as long
as it lives, no console request takes part in any use of it, and whoever ends up
holding the key need not be the person the grant went to. An Owner can want a
compliance officer to have the first without the second, and one checkbox
covering both would leave them no way to say so.

Every future presign that weakens a lock lands under `retention.override`, which
is the rule M1's route manifest states. Nothing further joins
`retention.key_mutation`, since those two granulars are the whole of what an
access key can do to a lock.

### 2. Where a grant lives

`privileged.grant` already answers who may confer, and only Owners hold it, so
the granting authority needs nothing new. What is new is the record of who holds
what.

Grants live in a new `PrivilegedGrantTable`, two rows per grant written in one
`TransactWriteItems`, the way M1 keeps a membership row and its inverse item
consistent:

| pk                              | sk                  | Attributes               | Purpose                             |
| ------------------------------- | ------------------- | ------------------------ | ----------------------------------- |
| `ORG#{orgId}#MEMBER#{userId}`   | `GRANT#{grantName}` | `grantedBy`, `grantedAt` | a member's grants are one partition |
| `ORG#{orgId}#GRANT#{grantName}` | `MEMBER#{userId}`   | `grantedBy`, `grantedAt` | the holder list for one grant       |

The table is new rather than an extension of FIL-1017's `BucketAccessTable`,
whose sort key is `{region}/{bucketName}` and whose design argument is that it
holds one subject, and rather than a partition of `OrgTable`, which FIL-1017
rules out because `ORG#{orgId}` is the partition every authenticated request
already reads. Grant kinds are open-ended, and this table is where the next one
lands.

**An Owner holds every grant by role, and no row is written for it.** Nobody can
take an Owner's holding away one row at a time, so the org cannot reach a state
where nobody is left to restore a grant. A
row adds a grant to somebody who is not an Owner. Only an Owner writes or deletes
a row, since doing so requires `privileged.grant`. A holder who is not an Owner
cannot confer onward, because conferring requires `privileged.grant` and a grant
row does not carry it. Any role can receive a grant, since the person who does
this work sits at whatever role the org gave them.

Resolving a grant costs one `GetItem` on `ORG#{orgId}#MEMBER#{userId}` /
`GRANT#{grantName}`, with `ConsistentRead` for the reason `org-membership.ts`
gives for the role read: an access-control read must not see a stale replica. It
runs only when a caller who is not an Owner asks for a privileged operation, so
no ordinary request pays for it.

### 3. The override rides on a presigned delete

A new presign operation, `deleteObjectBypassingGovernance`, signs a
`DeleteObject` with `x-amz-bypass-governance-retention: true` in `SignedHeaders`,
under the tenant's `filone-console` credential, expiring in the standard 300
seconds (`PRESIGN_EXPIRY_SECONDS`).

It is a distinct operation rather than a flag on `deleteObject`, because the
handler already branches per operation and the route manifest documents the
mapping operation by operation, which keeps the privileged case where a reader
looks for it. That also settles batching. `/api/presign` rejects a batch whole if
any operation in it is denied, and this operation may not appear in a batch at
all, which holds the relationship between a signing and its event at one to one.

Before signing, the handler reads the object's retention and writes the event
from what comes back ([§4](#4-three-events-and-the-one-that-cannot-be-written)).
A read that fails refuses the signing, since without it the event cannot say what
was overridden. Ordinary deletion is untouched and stays on `deleteObject`.

The vendor redeems the URL. Inside its five minutes a holder can redeem it any
number of times, or never, and FilOne observes none of that. A server-side delete
would observe the outcome, and it was traded away to keep object deletion on the
single path it already uses (see [Options considered](#options-considered)). The
third of FIL-1019's audit criteria is what that trade costs
([§4](#4-three-events-and-the-one-that-cannot-be-written)).

### 4. Three events, and the one that cannot be written

`retention_grant.granted`, `retention_grant.revoked`, and
`retention_override.signed`.

The first two join the `TransactWriteItems` that writes or deletes the grant
rows, the way M1's `commitAudited` handles a mutation that is ours alone, so a
grant cannot land unrecorded.

The third records the signing, carrying the actor, region, bucket, key, version,
and the retention mode and retain-until date read from the object at signing
time. Its name matches what it observes: a URL that nobody redeems still produces
the event, and one redeemed four times still produces a single event. Reading the
retention first costs an extra vendor call the presign path does not make today,
and after the delete nothing remains to show what was overridden.

FIL-1019 asks that every grant, revocation, and use be audit-logged. The design
meets two of the three. It cannot meet use, and neither can anything else within
the console's reach: the vendor performs the delete under the tenant's console
credential, and no backend reports object deletions back. An object-level
deletion feed from the orchestrators would close it, which is the same shape as
the bucket-lifecycle feed FIL-1017 asks for and belongs in the same conversation.

`retention.key_mutation` needs no event of its own. M1's `key.created` already
records the key and its permissions, so a key carrying either mutating granular
shows up in the log, and the holder list names the grant that allowed it.

Denials are not logged, for the reason FIL-1017 gives: one event per refusal
turns the audit log into a traffic log, and request-level logging is FIL-949.

### 5. Compliance retention is beyond every grant

No grant reaches an object under compliance retention, and none ever will. S3
gives compliance mode no override at any permission level, and the object
survives until its date passes. What the grant covers is the lock a customer
chose for its reversibility.

The console names which refusal a caller is looking at. A holder who overrode a
governance lock a moment ago and is then refused on a compliance-locked object
will read the refusal as a bug, and the vendor's `AccessDenied` explains nothing.
Four messages:

- The object is under compliance retention and cannot be deleted before its date,
  by anyone.
- The object is under governance retention and this region cannot override it yet
  ([§6](#6-rollout-the-grants-ship-before-the-capability)).
- The object is under governance retention and you do not hold
  `retention.override`.
- The object is under a legal hold, which is cleared rather than overridden, and
  no console operation clears one.

The last message names a real gap. Clearing a hold requires `PutObjectLegalHold`,
no presign operation mutates a legal hold, and adding one would land under
`retention.override` by [§1](#1-two-grants-defined-by-what-they-weaken).

### 6. Rollout: the grants ship before the capability

No backend carries the bypass action, so the override reports unavailable in
every region on the day it ships.

**What ships.** The table, with point-in-time recovery the way `OrgTable` has it
and an IAM grant narrowed to the operations the handlers perform. The
account-deletion teardown and `deletion-scrub.ts`, wired to it in the same PR
that creates it, before any row exists. Both grants in the registry vocabulary,
the grant editor, the holder list, and all three events. `retention.key_mutation`
becomes usable at once, since it replaces M1's blanket `privileged.grant`
elevation on `create-access-key` and needs nothing from a vendor. An org can
decide who would hold these before anyone can exercise them, and the log carries
those decisions from the first day.

**What does not ship.** The presign operation answers with the region-capability
refusal from [§5](#5-compliance-retention-is-beyond-every-grant), rather than
offering a button that returns 403.

The contract change is a request to three backends. The Management API spec gains
`s3:BypassGovernanceRetention` in `AccessKeyPermission`, FTH gains it in its
action vocabulary, and Aurora gains an access type for it. It travels in the
message carrying FIL-1017's bucket-lifecycle-feed ask.

Grant management sits on the members page beside the role editor, where an Owner
already goes to change what somebody can do and where FIL-1017 puts the
bucket-scope editor. The console offers the override on an object only after a
delete has been refused for a governance lock, which keeps a deliberate act
deliberate instead of putting a second button on every locked object. Both
surfaces sit behind the `ORGS_BETA` row pattern (`lib/orgs-beta.ts`), where
granting access is a row instead of a redeploy.

## Options considered

**A server-side override delete.** A handler performing `DeleteObject` with the
bypass header under the console credential is the one design where FilOne
observes the outcome and can write an event meaning the object is gone. It was
traded away to keep object deletion on the path it already uses: `presign.ts` is
the whole of object deletion in this product, and a second deletion path needs
its own error vocabulary, its own tests, and its own answer for versioned
objects. The orchestrator feed in
[§4](#4-three-events-and-the-one-that-cannot-be-written) closes the same audit
gap for every path at once.

**One grant instead of two** reads simpler on the members page and hides the
difference between one logged act on one object and a credential that weakens
locks for its lifetime with no console record of any use
([§1](#1-two-grants-defined-by-what-they-weaken)).

**A grant per lock mechanism** matches the vendor's vocabulary and produces three
grants, of which one is unusable by anyone, one duplicates an ordinary object
write, and one names an action no contract carries.

**Gating only `PutObjectLegalHold`**, on the ground that no credential can weaken
a retention while no credential holds a bypass action, scopes the gate to what is
reachable today. The day the bypass action lands on a console key to unblock a
support case, `PutObjectRetention` becomes destructive, and the gate that would
have caught it was argued away on the grounds that it could not.

## Open questions

1. **Which backend adds the action first.** All three need the same change
   request and none has committed. Aurora's is the largest, since its portal takes
   coarse access types and has no per-action vocabulary to extend. Until one
   lands, `retention.override` is a grant an org can confer and nobody can
   exercise.
2. **Whether bulk delete gains an override.** Emptying a bucket that will not
   delete is the realistic reason to want this, and refusing it means a grant
   holder clicks through a bucket one object at a time, which serves the audit log
   worse than one job with a stated scope. The business decision comes before the
   design, and the job would take its own event at creation rather than one event
   per object.
3. **What a customer key can do to a lock at each vendor.** Unmeasured.
   `retention.key_mutation` gates the two mutating granulars at minting, and
   whether either backend lets such a key shorten a governance retention without a
   bypass action is behaviour nobody has run. A one-bucket probe per backend would
   settle it.

## References

- Tickets: FIL-1019 privileged operations, FIL-1015 roles and the permission
  registry, FIL-1017 member bucket scope, FIL-1020 legacy key transition,
  FIL-1022 audit viewer, FIL-1024 per-region disclosure, FIL-949 request-level
  logging.
- [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md) for
  the permission registry, `privileged.grant`, the key-permission cap, and the
  audit write path this design extends.
- [`2026-08-member-bucket-scope-m2.md`](./2026-08-member-bucket-scope-m2.md) for
  the bucket-lifecycle feed this ADR's own vendor ask travels with.
- `packages/shared/src/route-manifest.ts:124-128`, where M1 recorded the rule
  [§1](#1-two-grants-defined-by-what-they-weaken) implements.
