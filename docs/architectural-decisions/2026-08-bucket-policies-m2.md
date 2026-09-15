# Bucket access by region: scoped keys on Aurora and FTH, IAM on Forge (IAM M2, FIL-1017)

**Status:** Draft (design exploration, awaiting acceptance)
**Created:** 2026-08-26
**Builds on:** [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md)
**Supersedes:** #642, #661, #662, #667

## Overview

FIL-1017 asks that an Owner or Admin can give a member access to a subset of
the org's buckets, and that a member holding a subset sees and acts on that set
alone.

We can deliver it on Forge, which we control, and not on Aurora or FTH, which
cannot model it. So the console carries two access models and branches on the
region in hand. Forge gets AWS-shaped bucket policies. Aurora and FTH keep the
scoped keys they ship today, capped by the member's role.

Access here is whole buckets. A prefix inside a bucket is later work.

## Background

The three storage backends do not model access the same way.

Aurora (`eu-west-1`) and FTH (`us-east-1`) model an org as a tenant and an
access key as a credential carrying its own permission set and bucket list,
fixed at creation. Neither can change what a key carries after minting, and
neither accepts a policy document. The key's bucket array is the only
bucket-scoping primitive either vendor exposes.

AWS models users. An access key belongs to a user and carries nothing of its
own, so a change to what the user may do reaches every key they hold without
reissuing any of them, and bucket policies grant bucket-level access to users
by name.

Forge is the backend we control. Its management API, Hilt, models tenants and
flat-permission keys today, the same shape as the vendors, and we can extend it
to model principals and policies because it is ours.

M1 made membership and roles real at the control plane and capped a new key at
its creator's authority. It left bucket scope to this milestone.

A **principal** is a member as the storage system knows them, `(tenantId,
userId)` and nothing more. It carries no permissions of its own: the storage
system computes what a principal may do from the bucket policies naming it, and
never learns the FilOne role name. A **scoped member** is a Member or ReadOnly,
who reaches a bucket only when a statement names them. Owners and Admins are
**unscoped**, which on an IAM region means the console grants them every bucket
rather than granting them by role at the storage system.

## Proposed access model

Each orchestrator declares the model its backend serves, `accessModel:
'scoped-keys' | 'iam'`.

### Scoped keys (Aurora and FTH)

An access key carries its own permissions and bucket list, the creator's role
caps the permission set at creation, and a role narrowing revokes the keys the
holder could no longer mint. Every member sees every bucket and the role
decides what they may do. There is no bucket-level scoping of members on either
production region. This half is built and merged.

### IAM (Forge)

Each member is a principal, bucket policies are the only thing that grants
access, and an access key belongs to a member and carries what the policies
give that member, evaluated per request. The role decides who may edit a policy
and what may go into a statement; it never crosses the interface. Until Hilt
ships the contract a Forge region declares `scoped-keys` and behaves as FTH
does, which is what its integration does today.

A region's model changes once, in that direction, per Forge network.

No production region declares `iam` today, so nothing about bucket visibility
changes on `eu-west-1` or `us-east-1`. Production customers see no
bucket-policy surface until a Forge region reaches GA. FIL-1017's acceptance
criteria are met on IAM regions and unmet on scoped-key regions, by decision.

Enumeration over S3 is a name listing in both models: `aws s3 ls` reaches the
storage gateway directly, every key we mint carries `s3:ListAllMyBuckets`, and
FTH and Forge list the whole tenant on any key. A name in that output has never
meant access, and `aws s3 ls` against AWS itself lists names the caller cannot
open. Org-wide aggregates also stay org-wide, so a scoped member can still
learn that other buckets exist. Scoping usage, billing, and the dashboard
counts means a per-bucket breakdown on each, and then the numbers a scoped
member sees stop matching the invoice.

## Bucket policies

A bucket policy is the bucket's own policy document, held by the storage system
and addressed by the bucket it belongs to:

```ts
// Addressed {region}/{bucketName}.
type BucketPolicy = {
  statements: {
    effect: 'Allow' | 'Deny';
    principals: string[]; // console user ids, or '*' for every member
    actions: (AccessKeyPermission | GranularPermission)[];
  }[];
};
```

This is S3's shape: one policy per bucket, statements naming individual
members, and both effects. The policy is created with its bucket and destroyed
with it. There is no policy id, no policy name, and no policy that outlives
what it grants access to.

The console stores none of it. No policy table, no membership-row marker, no
backfill. The console keeps orgs, memberships, roles, key attribution, and the
audit log. The enforcing system owns the rule it enforces, so there is no
second copy of a policy to drift. What the console does project outward is role
membership, as the statements it writes for unscoped members, and that
projection needs reconciling.

A member's effective permission on a bucket is what the statements say, and
nothing else:

```
union(Allow naming member) \ union(Deny naming member)
```

**An explicit Deny wins over an Allow.** This follows AWS, and it costs nothing
to reason about here because the storage system has no other input: it
evaluates principals against statements, and there is no role or ceiling for a
Deny to outrank. The one action outside the arithmetic is bucket enumeration,
which every principal holds and no Deny removes. A Deny naming an Owner takes
that bucket away from them until it is edited out, which an Owner can always
do, since the permission to edit a policy comes from their role and not from
the policy. A Deny naming every member locks the whole org out of a bucket
until someone does.

**Who edits** is `buckets.policy_manage`, a new permission held by Owner and
Admin. Those are the two roles `members.manage` already sits at, so nobody
gains or loses an ability the day it ships. Reading a policy takes the same
permission; a scoped member learns their reach from the bucket list and the key
form's preview.

**The vocabulary** is thirteen of the fifteen values on an access key: read,
write, list, delete, the two bucket-configuration reads, and the seven granular
data-protection permissions. `CreateBucket` and `DeleteBucket` are excluded,
because a key holding `CreateBucket` creates buckets outside the policy that
granted it. Bucket creation stays where M1 puts it, as the org-level
`buckets.create`.

**Retention and legal hold are grantable through a policy.** M1 makes
`PutObjectRetention` and `PutObjectLegalHold` Owner-only, and says M2's
per-operation grant replaces that blanket rule. The bucket policy is that
grant, and the check sits on the write: the console refuses a statement
carrying either action unless an Owner is authoring it. Once written, the grant
reaches whoever the statement names. The storage system enforces the statement
without knowing that either action was privileged, which is why the rule has to
hold at the console. On scoped-key regions the Owner-only cap stands, since no
policy exists there.

**A scoped member reaches no bucket until a statement names them.** There is no
all-buckets policy, so widening a Member on an IAM region means granting the
buckets they need or promoting them.

**Unscoped roles are granted, not inferred.** Because the storage system knows
only statements, an Owner or Admin reaches every bucket only because the
console put them on every bucket's policy. Every new bucket's policy names the
org's current Owners and Admins, and a promotion or demotion rewrites the
statements on every bucket in the region. The statement the console writes for
an Owner carries the full vocabulary; the one it writes for an Admin leaves out
the two mutating data-protection actions, which an Owner can still grant them
deliberately on a given bucket.

That fan-out is what a storage system with no notion of a role costs, and it
cannot be atomic. A promotion that fails halfway leaves the member unscoped on
some buckets and not others, so each write is idempotent, the role change
reports which buckets it reached, and a reconciliation job compares each
region's policies against the org's roster and repairs the difference. That job
also carries a change to the role matrix, which no membership event would.

**Editing happens on the bucket.** The policy is a tab on the bucket detail
page, beside Objects and API Keys, and absent for a role that cannot read it.
The member detail page carries a read-only list of the buckets a member
reaches, so an admin can answer "what does this person have" from the person's
page.

**Concurrent edits take a compare-and-set.** With no policy id there is no
version to bump, so the storage system supplies one instead. A read returns a
strong ETag over the stored document, a write carries it back, and a write
whose ETag no longer matches is refused with nothing written. Creating a
bucket's first policy is the same check against no policy existing.

## Architectural changes

Our goal is to leave most of the console alone. The membership rows, the audit
path, the key attribution, and the whole scoped-key flow are untouched.

### Per-member console credentials

Today the console signs all its S3 traffic with one tenant-wide credential per
region and filters the results itself. On an IAM region it instead signs each
member's traffic with a credential belonging to that member, and the data plane
authorizes and filters.

That removes the second enforcement point for object traffic. It does not
remove it everywhere: `ListBuckets` is a tenant-wide name listing and every
principal holds `s3:ListAllMyBuckets`, so the bucket list and the activity feed
still filter in the handler against the member's resolved access.

- The console mints `filone-console/{userId}` through the member-key call,
  lazily on that member's first signing request in a region. Key names are
  unique per principal, so it cannot collide with a customer key.
- The secret lives on `UserInfoTable` as a KMS-encrypted attribute under the
  org's partition, which the account-deletion scrub already sweeps. SSM holds
  one secret per org today; per member the count becomes members multiplied by
  IAM regions, past what a parameter store is meant to carry. There is no
  envelope-encryption helper in the console yet, so this is new code.
- The credential cache is keyed by tenant today. It gains the user id and a
  maximum age, so a credential the storage system deleted cannot stay warm. A
  403 evicts and re-mints once.
- The credential is deleted with the principal, in the same narrowing
  transaction that already deletes the member's keys.

Some traffic has no member actor and stays on the tenant-wide credential:
tenant setup, bucket create, bucket delete, the bulk-delete and RAG-indexer
workers, and the activity feed's bucket fan-out. Usage and analytics never
touch an S3 credential at all; they are management-API calls under the partner
key.

The usage handler subtracts exactly one console key from the org's key count,
and N member credentials break that arithmetic. Nothing else is spent: Hilt
enforces no key limit, and the per-tenant limit the console reads is the
vendors' own.

`getBucket` has to change first. It proves a bucket exists by filtering a
tenant-wide listing, so today it answers 200 for a bucket the caller cannot
reach. Existence moves onto the bucket-addressed versioning and object-lock
calls the handler already issues, which the storage system authorizes per
bucket.

**Presigned URLs improve.** A URL signed with the member's credential is
authorized against the member's principal when it is redeemed, and a redeemed
URL never re-enters the console, so this is the one place the second check
disappears completely. The 7-day download limit becomes the shortest of 7 days,
the credential's remaining life, and SigV4's own limit, which means a member
credential that expires shortens the longest share link a member can create. We
keep the credential unexpiring for that reason.

**What we give up is freshness on object traffic.** A per-request resolve is
consistent with the storage system's last write. A credential cached at the
gateway is good until the staleness bound, so removing a member from a bucket's
policy stops their object browsing when the revocation reaches the gateway
rather than at their next click, which is a firehose hop and not a wait for the
cache to expire. Bucket-addressed reads are never served from that cache and
stay as fresh as they are today. The console can no longer refuse on its own,
only relay what the data plane answered, so containment on Forge becomes wholly
the storage system's. A bucket out of reach comes back as a missing bucket and
a forbidden action as a refusal, which is the pair the console surfaces.
Nothing widens, because a narrowing that cannot reach the storage system is
refused. And during a Hilt outage a warm credential keeps a scoped member's
object browsing working, where today those reads fail closed.

### The orchestrator interface

The interface becomes a discriminated union on `accessModel` over a core both
arms share: tenant lifecycle, buckets, the S3 client context, usage, and key
deletion.

The scoped-keys arm is today's `issueAccessKey` and `findAccessKeyByName`,
unchanged.

The IAM arm is shaped after the IAM API without its request bodies:

| Method                                                     | Contract                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `syncMember(tenantId, userId)`                             | asserts the principal exists so a key can bind to it; carries no permissions; idempotent |
| `removeMember(tenantId, userId)`                           | deletes the principal, its keys, and every statement naming it; idempotent               |
| `getBucketPolicy`, `putBucketPolicy`, `deleteBucketPolicy` | bucket-addressed; the write carries the token the read returned                          |
| `listBucketPoliciesForMember(tenantId, userId)`            | the member detail view                                                                   |
| `resolveMemberAccess(tenantId, userId)`                    | per-bucket permissions, for the bucket list and the activity feed                        |
| `issueMemberKey(tenantId, userId, opts)`                   | a key bound to a principal, with a name and expiry only                                  |
| `listAccessKeys(tenantId, opts)`                           | identity fields plus each key's principal and its access                                 |

A vendor that grows principals and policies moves its region to `iam` by
implementing that arm, with no console change.

Tests get two fakes typed against the union. The IAM fake is an in-memory
implementation of the contract below, and it is what the console work builds
against while Forge implements the real thing.

### Audit events

Policy changes take M1's intent-and-completion pair around the interface call:
`bucket_policy.created`, `bucket_policy.updated`, and `bucket_policy.deleted`,
keyed by region and bucket name. A policy is one bucket's document, so every
roster change is an update to it and there is no separate members-changed
event. One event per action rather than per member, since an edit touching
twenty members would otherwise write twenty events.

Denials are not logged. A scoped member reaching for a bucket outside their
policies gets a 404, and one event per 404 turns the audit log into a traffic
log.

## Access flows

**A member reaches a bucket.**

1. The console resolves the member's role and, on an IAM region, gets or mints
   their credential for that region.
2. For the bucket list and the activity feed, the handler reads the member's
   per-bucket access and filters the region's results.
3. Every other bucket-addressed route goes to the data plane signed with the
   member's credential.
4. The storage system evaluates the bucket's policy against the principal and
   answers.
5. An out-of-reach bucket answers exactly like a bucket that does not exist:
   same status, same body. A distinct code would confirm the bucket exists. A
   member whose access was removed while their tab was open sees "Bucket not
   found".

**An admin grants a member access to a bucket.**

1. An Owner or Admin opens the bucket's policy tab and adds an Allow statement
   naming the member and the actions.
2. The console writes the document with the token it read; a stale edit loses
   and is re-read.
3. The grant binds on the member's next request. Their existing keys pick it up
   with no reissue, because a key's authority is its member's.

**A role narrowing.** The admin sees what will happen before confirming, in
every case.

1. The console computes the preview: on scoped-key regions, which of the
   member's keys the new role could not mint; on IAM regions, the member's
   policy count and what their keys will follow.
2. Every local precondition, the owner count included, is checked before the
   first vendor call.
3. On scoped-key regions the excess keys are revoked at the vendor, each
   through the existing per-key deletion flow, before the role is written.
4. On IAM regions a demotion out of an unscoped role rewrites the statements
   naming that member on every bucket in the region, before the console row,
   and the response reports the buckets it reached. Demotion to a role that
   cannot hold a key deletes the member's keys in both models; every other
   narrowing follows live, since a key carries only what the policies give its
   member.
5. The role is written, the member is emailed, and the completion event carries
   the revoked key ids and the regions synced.

A widening runs in the other order. The console row commits first and the sync
follows, so a principal is never wider at the gateway than the role that
authorized it.

**A scoped member creates a bucket.**

1. `POST /api/buckets` calls the management API's bucket create with the policy
   in the same request, signed with the tenant-wide credential.
2. The policy names the org's current Owners and Admins in one Allow, and the
   creator in another with the actions their role permits. An unscoped creator
   is already in the first statement.
3. The storage system commits the bucket and its policy together, so a failure
   leaves no bucket and never a bucket its creator cannot see.

The gateway has not seen a bucket created this way and registers it on the
first bucket-info call for the name.

**Removal.**

1. `removeMember` runs on every provisioned IAM region before the membership
   rows are deleted.
2. It deletes the principal, every key bound to it, and every statement naming
   it.
3. The member's console credential and key rows for that region go in the
   membership transaction.

Stripping the statements matters. A removed member who is later invited back
keeps the same console user id, so statements left behind would silently
restore their old access on the new invitation.

**An invitation carries its grants.** An invitation to a Member or ReadOnly
names the buckets and actions they start with, on the invitation row M1 already
writes. Acceptance is a widening: the membership row commits, then each named
bucket's policy gains a statement. A bucket deleted inside the 14-day window is
skipped and named in the acceptance event. An Owner or Admin invitation names
no buckets, and acceptance adds them to every policy in the region.

**RAG API keys already follow their creator.** A RAG key resolves its creator's
membership at query time and refuses when it is gone, and on an IAM region its
bucket references are checked against the creator's access on every query. They
sit outside the revocation pass.

**Org deletion** needs no new path. Deleting the tenant destroys its
principals, policies, and keys, and the deletion scrub already reads the whole
org partition.

**Deleting a bucket** removes its policy with it and revokes nothing. No
delegation names a single bucket in this model, so there is nothing to revoke;
the gateway drops the bucket from its registry on the same request and refuses
any bucket it does not know, which retires the warm chains by itself.

## The IAM contract for Forge

These requirements are a revision of the management API contract, added as an
optional capability set. A Forge region declares `iam` when its network serves
that revision. Only Forge is asked to implement it.

**What Hilt has today.** Tenants, their access keys, and their buckets, plus
the UCAN delegations behind them. A key is a flat row of permissions and bucket
names, evaluated per request by two membership tests. At key creation Hilt
stamps tenant-to-key delegations, one per command and subject. Per request it
re-delegates each command to the gateway with the bucket as subject, expiring
at the next UTC midnight plus clock skew; the gateway caches those chains to
the same horizon, and bucket-level operations are never served from that cache.
On key delete and bucket delete Hilt publishes revocations before deleting its
own rows and fails the call if the revocation service errors, and the gateway's
consumer drops the revoked key's cache. That is the one existing path for
pushing a change to a warm key. There is no principal, user, role, or policy
object anywhere, and no route updates a key.

**What we need.**

1. **A tenant service credential** outside the principal model: the console's
   own key, tenant-wide and unexpiring, minted at tenant setup before any
   principal exists, and mintable on demand for a tenant that predates the
   model. It is not a customer key and sits outside the key list, the key
   count, and the revocation rules.
2. **Principals** per tenant, `(tenantId, userId)`, that a key can bind to and
   a statement can name. A principal carries no permissions, no role, and no
   all-buckets flag, so there is nothing on it to keep in step with the
   console. It does need an identity of its own that a revocation can target. A
   batched write for the provisioning sweep.
3. **Bucket policies** addressed by bucket: a statement list carrying effect,
   principals, and actions; an ETag the caller passes back to make an edit
   conditional; and a query by principal. The management API carries no actor,
   since who may edit a policy is the console's decision.
4. **Keys bound to a principal**, issued with a name and expiry only, names
   unique per principal. The console holds one such key per member for its own
   traffic.
5. **Per-request authority** computed from the bucket's policy alone, `Allow \
Deny` for the calling principal, with an explicit Deny winning. A key's
   permission set is derived, never stored: the flat permissions and buckets
   fields on today's key do not describe an IAM key. A member-access read
   returns a principal's per-bucket access, is consistent with Hilt's own last
   write, and carries a latency target, since the bucket list and the activity
   feed resolve it per request. Deny is what makes this more than a proof-chain
   check: several S3 actions map to the same Forge commands, so the gateway has
   to hold each key's effective action set per bucket and refuse anything
   outside it rather than probing for a chain.
6. **Revocation before acknowledgement.** Every narrowing of a principal or a
   policy publishes revocations for the delegations it invalidates before Hilt
   acknowledges the change, and refuses the change outright when it cannot, so
   a failed narrowing leaves the old access rather than a stale one. The
   propagation time is the published staleness bound: a revocation that reaches
   every warm cache holding a principal's grants, independent of when those
   caches would have expired on their own. A policy edit costs on the order of
   the statements it changes and touches no key, since a key holds no authority
   of its own.
7. **The `s3:*` vocabulary** crosses the API through the existing mapping, and
   every principal holds `s3:ListAllMyBuckets`, which no statement grants and
   no Deny removes. The contract enum gains `s3:AbortMultipartUpload` and
   `s3:ListMultipartUploadParts`, which Hilt already accepts.
8. **Tenant identity per org and region.** When one network serves two regions
   for one org, the implementation sends a region-qualified external id, and
   Hilt's one-provider-per-tenant model holds unchanged.

A bucket lifecycle feed would help and is an ask rather than a requirement.

## Migration strategy

Merges to `main` auto-deploy to production, so every step is independently
production-safe and a migration ships as a script-only PR before anything that
depends on it.

1. The `accessModel` discriminant and the interface split, with every region
   declaring `scoped-keys`. Merged, no behavior change.
2. Role-narrowing revocation with its preview route, dialogs, email, and audit
   shape. Merged. It revokes nothing by itself; a key is revoked only by a
   later narrowing that leaves it above the new role.
3. The IAM console surfaces, `buckets.policy_manage`, and the IAM fake. Dark,
   because no region declares `iam`, and behind the `ORGS_BETA` row pattern
   besides, where granting an org access is a row rather than a redeploy.
4. The per-member credential store with its envelope encryption, and the
   `getBucket` existence change. Both are prerequisites for the flip.
5. The per-network flip when a Hilt network ships the contract. The gateway
   ships before the management API, since it has to enforce the new action sets
   before any key depends on them. The flip then retires every key on the
   network, including the console's own credential, so the console mints a
   fresh one per tenant, writes principals for existing members through the
   provisioning sweep, writes a policy per bucket naming the org's Owners and
   Admins, and changes the registry entry last. No key on the network works
   between the management-API deploy and that entry, which is tolerable only
   because Forge runs demo and dev today. `eu-central-3` and `us-east-9` flip
   on their own schedules. After the flip, Hilt availability gates membership
   writes for orgs with a tenant on that network.

## Options considered

**Multi-bucket policies with a member roster.** A named rule over a set of
buckets, composing by union, is fewer writes for an admin granting a team eight
buckets: one policy instead of eight. It is not what S3 means by a bucket
policy, and matching S3 is the point of the exercise. A policy that lives
somewhere other than its bucket needs a join only the console could evaluate,
which puts the rule back outside the system enforcing it. Overlapping policies
also compose upward only, so an admin who narrows one has not narrowed the
member.

**Console-side resolution with a shared tenant credential.** Signing every
request with one key and filtering the results ourselves asks nothing new of
the storage system. It also means two enforcement points for one rule, a round
trip on the console request path, and no protection at all for a direct S3 key.

**An all-buckets flag on the principal.** One boolean meaning "this principal
reaches every bucket" makes a promotion a single write instead of one per
bucket, and it is not a permission ceiling, so statements would still decide
the permission set. It is a second input to an access decision, held outside
the policy and needing to be kept in step with the role. Holding the storage
system to exactly one input is worth the fan-out.

**Per-member FTH storage users.** FTH is the one vendor with a user object, and
keys already hang off one. Those keys would still carry their own permissions
and nothing would follow the member live, so it is the scoped-key model under a
second name.

## Open questions

1. How long does a narrowing take to reach the gateway? The path is a
   revocation on the firehose rather than a cache expiry, so the number should
   be small, and it is unmeasured. It is the figure Forge publishes.
2. Should the console refuse a Deny naming every member? The storage system
   accepts one, and it is the console that knows a Deny is about to lock an org
   out of its own bucket until an Owner edits it back. A statement naming
   everybody is useful in an Allow, as the way to grant a bucket to the whole
   org.
3. What is the latency of the per-bucket access read, which the bucket list and
   the activity feed resolve on every request?
4. Should FIL-1017's `ListBuckets` criterion be relaxed, or should the gateway
   filter the listing? Filtering is a change to a system we own, and the closed
   Hilt PR is the prior attempt at it.
5. Does a partially failed multi-region revocation need an operator view, or is
   the retry on the same request enough?
6. How large does the unscoped-role fan-out get in practice? A promotion
   rewrites one policy per bucket in the region, and we have no figure for
   buckets per org on Forge. If it turns out large, the management API taking a
   batch of policy writes would fix it.

## Future work

**Prefix scope** inside a bucket (FIL-1018) fits the statement shape directly
and is Forge-only.

**Narrow service credentials.** A member-bound key carries the member's whole
access, so a read-only credential for one application has no home on an IAM
region. AWS's answer is a user per workload, and the PRD puts service accounts
out of scope.

**Bucket lifecycle observation.** Key-mediated bucket creation and deletion
stay unobserved, because no management API exposes which key acted. The
console-mediated path writes `bucket.created` and `bucket.deleted`, and a
lifecycle feed from an orchestrator is what would close the rest.

## References

- Tickets: FIL-1017 member bucket scope; FIL-1018 revocation timing and prefix
  scope; FIL-1019 privileged operations; FIL-1022 audit viewer; FIL-1024
  per-region capability disclosure.
- [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md)
  for roles, the permission registry, the creator cap, the audit write path,
  and the script-only-PR rule.
- [`2026-08-multipart-upload-permissions.md`](./2026-08-multipart-upload-permissions.md)
  for the contract enum gap and the console key's lifecycle.
- `docs/service-orchestrator-integration/management-openapi.yaml`, the contract
  the IAM revision lands in.
- The scoped-key half is merged, in PRs #669 through #675: `AccessModel` in
  `packages/shared/src/constants.ts`, the retention test in
  `packages/shared/src/access-key-permissions.ts`, and the revocation pass in
  `packages/backend/src/lib/revoke-member-keys.ts`.
- Hilt and Ingot behavior is read from `fil-forge/hilt` and `fil-forge/ingot`
  at `origin/main`.
- Staging measurement, 2026-08-26: out-of-scope object reads and `ListBuckets`
  behavior on Aurora and FTH. `HeadBucket` answers 403 rather than 404 for a
  bucket outside a key's scope on both, so a member who guesses an exact name
  confirms it exists.
- The enforceability memo, `iam-prd-enforceability-by-backend.md` in the knowledge-base repo (2026-08-11),
  sorted the PRD's requirements by what each backend can enforce. It is the
  source of the Forge-first path.
