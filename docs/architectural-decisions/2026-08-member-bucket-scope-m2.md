# Member bucket scope (IAM M2, FIL-1017)

**Status:** Draft — design exploration, not yet accepted
**Created:** 2026-08-26
**Builds on:** [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md)

## What this delivers

An Owner or Admin gives a member access to every bucket in the org or to a
named set of them. A member holding a named set sees only those buckets: the
console renders only those, `GET /api/buckets` returns only those, and every
bucket-addressed route answers as if the others do not exist.

A scope names whole buckets. Scoping a member to a prefix inside a bucket is
Tier 3 work in the Forge enforcement story (FIL-1018), not this milestone.

Five decisions shape the design:

1. **Enforcement is the console API.** Out-of-scope buckets are refused at the
   BFF. The tenant-wide console credential and existing SigV4 keys are not
   narrowed; that is M3.
2. **A grant is one row per (member, bucket), in a table of its own.**
3. **Hiding covers bucket-addressed reads.** Org-wide aggregates (usage,
   billing, dashboard counts, the activity feed) stay org-wide.
4. **A scoped member who creates a bucket is granted it in the same request.**
   Every other member's scope changes only when an Owner or Admin says so.
5. **Bucket creation and deletion stop being available on user keys** (§8),
   until an orchestrator can report that a bucket's lifecycle changed and which
   key changed it. The console keeps both; a customer's own credential loses
   them.

## What the code gives us

**FilOne stores no bucket records.** A bucket exists at the orchestrator and
nowhere else. `list-buckets.ts` fans out across provisioned regions and merges
what answers; `get-bucket.ts` calls one orchestrator. So a grant names a bucket
that FilOne cannot validate locally, and a grant can outlive the bucket it
names.

**A bucket's identity is `(region, bucketName)`.** Every bucket-addressed route
carries a region (`get-bucket.ts:30` defaults to `S3_REGION`), `BucketSummary`
carries one, and the RAG tables already key on
`BUCKET#{orgId}#{region}#{bucketName}` (`lib/dynamo-records.ts`). S3 bucket
names contain no `/`, so `{region}/{bucketName}` composes into a key
unambiguously.

**The membership row is where the caller's authorization state already
arrives.** M1's ADR hands handlers the row itself on `userInfo.membership`
(`lib/user-context.ts`), resolved by `authMiddleware` on every authenticated
request.

**The console signs object operations with one tenant-wide credential.**
`presign.ts` calls `orchestrator.getS3ClientContext(tenantId)`, which resolves
the per-tenant `filone-console` key from SSM (`lib/s3-credentials.ts`). That
credential addresses every bucket the tenant owns. Whatever the console refuses
to sign is the whole of the enforcement, which is what decision 1 accepts.

**Key issuance already takes a bucket list.** `IssueAccessKeyOpts.buckets` is
honored by all three orchestrators (`fth-orchestrator.ts:228`,
`aurora-orchestrator.ts:199`, `orchestrator/orchestrator.ts:314`), and the
create-key request already carries `bucketScope: 'all' | 'specific'` with a
`buckets` array (`packages/shared/src/api/access-keys.ts:159`). The cap in §6
is a comparison between two sets that both already exist.

## 1. Data model

Grants live in a new `BucketAccessTable`, declared in `sst.config.ts` beside the
existing tables. One attribute joins the membership row in `OrgTable`.

| Table               | pk                                       | sk                     | Attributes               | Purpose                                     |
| ------------------- | ---------------------------------------- | ---------------------- | ------------------------ | ------------------------------------------- |
| `BucketAccessTable` | `ORG#{orgId}#MEMBER#{userId}`            | `{region}/{bucketName}` | `grantedBy`, `grantedAt` | the grant; a member's scope is one partition |
| `BucketAccessTable` | `ORG#{orgId}#BUCKET#{region}/{bucketName}` | `MEMBER#{userId}`     | `grantedBy`, `grantedAt` | inverse: who can see this bucket             |
| `OrgTable`          | `ORG#{orgId}`                            | `MEMBER#{userId}`      | `bucketScope`            | whether the grants apply                     |

**A grant is one row, so grants do not collide.** Two admins granting different
buckets to the same member write different rows. Nothing is read-modify-written,
nothing needs a version condition, and a grant is one write rather than a
rewrite of a set that grows with the member's access.

**`bucketScope` stays on the membership row, and it is what makes the common
case free.** Zero grant rows is ambiguous between "unscoped" and "scoped to
nothing", and resolving that from the grant table would put a Query on every
request just to learn that most callers are unscoped. `authMiddleware` already
reads the membership row, so `bucketScope: 'all'` answers the question with no
I/O at all. Only a scoped caller, and only on a bucket-addressed route, reads
the grant table. `'specific'` with no grant rows is a member who can see no
bucket, and it fails closed.

`'all'` is evaluated per request rather than materialized into grants, so a
bucket created after the marker was written is inside an `'all'` scope by
definition, with nothing to write when it appears.

**Its own table, not `OrgTable`.** Grants are unbounded per member and would
otherwise share the `ORG#{orgId}` partition with the membership, invitation, and
`META` rows that every authenticated request already reads, concentrating a
growing row count on the partition the product is hottest on. A separate table
keyed per member gives each member's grants their own bounded partition, lets
the IAM grant be narrowed to what the handlers actually do (the M1 ledger's
open item on the audit table is the same lesson arriving late), and keeps
`OrgTable`'s key space to the org domain the M1 ADR scoped it to.

**Both rows are written in one `TransactWriteItems`**, on grant and on revoke,
the way membership and its inverse item are kept consistent.

**Reads are consistent.** A revoke must bind on the next request, so the grant
reads carry `ConsistentRead` for the reason `org-membership.ts` gives for the
role read: an access-control read must not see a stale replica.

**Absence of `bucketScope` means `all` during rollout, then stops meaning
anything.** Every membership row written before this work carries no marker, and
today every member sees every bucket. The backfill stamps `'all'` on every row
and the fallback is removed in the following PR, which is the sequence M1 used
for the role fallback (`2026-08-organizations-roles-m1.md`, §2).

### Alternatives

**A String Set on the membership row** (`buckets`, holding the same
`{region}/{bucketName}` entries) needs no new table and no read at all, since
the scope arrives on the row `authMiddleware` has already fetched. `ADD` and
`DELETE` are atomic, so grants still do not collide. It caps one member at
roughly 14,000 entries against the 400KB item limit, which no tenant approaches,
but the row is read on **every** authenticated request at 1 RCU per 4KB: a
member scoped to a thousand buckets makes ~28KB, or 7 RCU, of every request in
the product, including the routes that never touch a bucket, and all of an org's
membership rows share one partition. The ceiling is comfortable and the hot-path
cost is what rules it out.

**Named bucket groups** — an org defines a group, members hold groups — match
how a team with many buckets would describe the rule, and one edit re-scopes
everyone holding the group. They cost a new entity with its own CRUD, console
surface, and lifecycle, and every request resolves member → groups → buckets
instead of member → buckets. Groups can be layered on later: a group would
expand into the same grant rows, so nothing in §2 changes.

## 2. Resolving a scope on a request

A lib module in the shape `lib/key-scope.ts` uses for the same problem one level
up: a permission the handler ignores is a permission that does not exist. The
difference is that this one does I/O, so it is an async resolver rather than a
pure function.

```ts
export type BucketScope =
  | { sees: 'all' }
  | { sees: 'listed'; orgId: string; userId: string };
```

`Owner` and `Admin` are unscoped by role; a caller whose membership row says
`'all'` is unscoped; everyone else is `listed`. An unscoped caller's grant rows
are not read, on any route — the role and the marker settle the answer before
the table is reached — and they are not deleted either. Widening a scope, and
promoting a member out of one, both leave the rows in place (§9). Which read
follows depends on the route:

- **`GET /api/buckets`** issues one `Query` on the member's partition and
  filters the merged fan-out result against it. The Query walks every page: the
  key-listing routes already carry a first-page-only bug on the M1 follow-up
  ledger, and a scope that silently truncates hides buckets a member was
  granted.
- **Every bucket-addressed route** issues one `GetItem` on the exact grant key.
  No Query, no list, O(1) per request.

The check runs in the handler rather than in middleware. `authorize()` decides
from the route manifest alone and the manifest cannot name a bucket; the bucket
arrives in a path parameter or, for `POST /api/presign`, in each element of the
body. This is the `in-handler` requirement M1 already defined for presign.

## 3. Where the check goes

| Route                                     | Scoped behavior                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/buckets`                        | filter the merged fan-out result to the granted set                         |
| `POST /api/buckets`                       | allowed; the new bucket is granted to the creator (§5)                      |
| `GET /api/buckets/{name}`                 | no grant row → the same 404 a missing bucket returns                        |
| `DELETE /api/buckets/{name}`              | gated on `buckets.delete`, which only an unscoped caller holds (§2)         |
| `GET /api/buckets/{name}/analytics`       | 404                                                                          |
| `GET \| POST /api/buckets/{name}/rag/enabled` | 404                                                                      |
| `POST /api/buckets/{name}/bulk-delete`    | 404                                                                          |
| `GET /api/bulk-delete-jobs/{jobId}`       | the job row names its bucket; check that bucket, 404 otherwise              |
| `POST /api/presign`                       | check every operation's bucket; one denial refuses the batch                |
| `POST /api/buckets/{name}/query` (bearer) | the key creator's scope applies (§6)                                        |
| `POST /api/access-keys`                   | requested bucket scope is capped at the creator's (§6)                      |
| `POST /api/rag-api-keys`                  | same cap                                                                     |
| `POST /api/org/invitations`               | carries the invited member's scope, materialized on accept (§9)             |
| `PATCH /api/org/members/{userId}`         | carries scope changes, and refuses a narrowing that strands keys (§9)       |

The last two are M1 routes gaining a payload rather than new ones, and they keep
the requirement they already declare: `members.manage`, which FIL-1017's "Owner
or Admin assigns a bucket scope" matches exactly. Assigning a scope is part of
inviting and managing a member, so it needs no permission of its own.

**An out-of-scope bucket answers exactly like a bucket that does not exist.**
Same status, same body, no new `ApiErrorCode`. A distinct code would confirm
the bucket exists, which is the thing being hidden. The cost is a worse message
for a member whose access was revoked while their tab was open: they get
"Bucket not found" where "your access was removed" would be truthful. Hiding
and explaining are exclusive here, and hiding is what the feature is.

`POST /api/presign` refusing the whole batch follows M1's rule for a batch
containing a denied operation. A presign batch names one or two buckets, so the
per-operation checks are a `BatchGetItem` rather than a read per element.

## 4. What stays visible

Decision 3 scopes bucket-addressed reads and leaves aggregates alone. A scoped
member can therefore still learn that other buckets exist:

- `GET /api/activity` renders bucket creations, deletions, and key events by
  name, org-wide.
- `GET /api/usage` and `/api/usage/trends` report org-wide bytes and object
  counts; the dashboard's bucket count and key count are org-wide totals.
- `GET /api/billing` is org-wide by construction: the subscription is the org's.
- Any SigV4 key the member already holds keeps its own authority, and a
  `ListBuckets` over S3 never reaches a FilOne handler at all (§7).
- Presigned URLs already issued stay valid until they expire, up to 7 days for
  downloads (`handlers/presign.ts:40`). That is the real revocation bound for
  object reads after a scope change, the same bound M1 records for role changes.

Closing the first three is a per-bucket breakdown on each aggregate, and the
numbers a scoped member sees then stop matching the invoice. Closing the last
two is M3.

## 5. Buckets that appear after the grant

`create-bucket` writes the creator's grant rows **before** calling the
orchestrator, and deletes them if creation fails. A grant naming a bucket that
does not exist grants nothing, so the pre-write is safe in a way the post-write
is not: a grant write that fails after a successful create leaves a member
unable to see the bucket they just made.

The two steps cannot be one transaction, because the bucket lives at the
vendor. The failure that survives is a grant left behind by a failed create,
which is inert until someone creates a bucket of that name in that region, and
that someone is granted it anyway.

**Name reuse is the sharp edge.** Delete a bucket, create another with the same
name in the same region, and every stale grant applies to the new bucket.
FilOne has no bucket identifier to bind a grant to, so `delete-bucket` sweeps
the grants through the inverse partition, which is what that row family is for.
The sweep is bounded by the org's member count rather than by anything that
grows with usage. It sits outside the delete's own atomicity, and a grant it
misses is a member seeing a bucket nobody gave them.

Both halves of this section assume the console performed the operation. A
create or delete issued against the S3 API reaches no handler, so neither the
grant nor the sweep happens, which is what §8 proposes to close.

## 6. Capping what a scoped member can mint

M1 caps a new key's *permissions* at the creator's console permissions and
defers the bucket half to this milestone. With scope in place:

- A creator whose scope is `all` is unaffected.
- A scoped creator names buckets from their own grants. A bucket outside them is
  refused, naming the bucket.
- A scoped creator cannot request `bucketScope: 'all'`. The console offers that
  choice only to unscoped callers, and the handler refuses it whatever the
  console sent. Materializing `'all'` into the creator's current grants would
  mint the same key while hiding what it reaches, and the member would read the
  key as following their access.

Every key a scoped member holds is a snapshot. Widening a member's scope does
not widen the keys they already minted, and reaching a newly granted bucket
means minting a new key. The console says so at creation, and again when an
Owner or Admin widens somebody's scope.

The snapshot is a property of the backends rather than of this design. Aurora's
keys are immutable and FTH has no key-update endpoint, so the only way to change
what a key reaches is to revoke it and issue another, which changes the access
key ID and breaks whatever client was using it. Forge gets out of that once
FIL-918 lands: a key narrows in place, keeping its ID, and a key read returns
its effective permissions and bucket scope from the enforcing system instead of
from our own record. The console flow is then one flow with two regional
outcomes — update the key on Forge, revoke and replace it elsewhere (FIL-1017)
— and that difference is one of the rows FIL-1024's per-region matrix has to
show.

`CreateBucket` and a non-empty bucket list contradict each other: a key that
may only operate on the buckets it names cannot create one it does not name. A
scoped member holding `buckets.create` therefore creates buckets in the console
rather than with their own keys, and the key form should not offer the pair.
The exact refusal is the vendor's, so it joins the behaviors §7 sends to be
verified.

## 7. ListBuckets over S3

`aws s3 ls` reaches the storage gateway directly and never touches a FilOne
handler, so §3 does nothing for it. Every key FilOne mints carries
`s3:ListAllMyBuckets` unconditionally (`ALWAYS_PERMISSIONS`,
`orchestrator/orchestrator.ts:497`; `FTH_ALWAYS_PERMISSIONS`,
`fth-orchestrator.ts:379`), Aurora grants it among its default permissions, and
the console renders it as a checked, disabled checkbox
(`docs/S3Considerations.md`). A scoped member holding any key can enumerate
every bucket in the org.

**The orchestrator APIs expose exactly one bucket-scoping primitive:** the
`buckets` array on an access key. It is `CreateAccessKeyRequest.buckets` in the
Management API contract ("when set and non-empty, the key may only operate on
these buckets"), the same field on Aurora's portal API, and the same on FTH.
There is no bucket ACL, no per-user bucket ownership, and no ListBuckets filter
in any of the three. FTH's storage users come closest, since keys are minted
under one and FilOne creates a single `filone-console` user per tenant, but a
storage user carries no bucket scope of its own (`FthStorageUser`), the generic
Management API has no equivalent concept, and Aurora exposes none. A per-member
storage user would buy attribution rather than filtering.

**The requirement is settled and the mechanism is not.** FIL-1017 asks for
out-of-scope buckets to be "absent from console and from ListBuckets on that
member's keys", so filtered enumeration is a stated acceptance criterion rather
than a choice. What no contract answers is whether the gateways already deliver
it: does a key carrying both `s3:ListAllMyBuckets` and a non-empty `buckets`
array return the whole tenant's buckets or only the named ones? `ListAllMyBuckets`
acts on the tenant rather than on a bucket, so "may only operate on these
buckets" reads either way, and neither the Management API description nor
Aurora's schema settles it. The answer is per-orchestrator and decides which
option below each region needs.

| Option                                       | What it gives                                                                                                          | What it costs                                                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope the key, let the gateway filter        | Nothing to build: §6 already puts the member's buckets on the key, end to end on all three backends                     | Complete only where the gateway filters. Where it does not, the key cannot *operate* on an out-of-scope bucket but can still recite its name                          |
| Withhold `s3:ListAllMyBuckets` on scoped keys | Enumeration is refused whatever the gateway does. `aws s3 ls s3://granted-bucket` still works, since that is `ListBucket` | `aws s3 ls` answers AccessDenied, which breaks tooling that enumerates first. The always-on set becomes conditional, and Aurora may grant the action with no way to omit it |
| The backend enforces the key's scope itself  | The gateway answers correctly with no help from us, which is what M3 builds on Forge (FIL-1025, on Hilt's key vocabulary and permission read-back, FIL-918) | Reaches Forge only. Aurora's keys are immutable and FTH has no key-update endpoint, so on those two it is a vendor ask with no date |

**Ship the first, fall back to the second per region, and let the third arrive
with M3.** Scoping the key is already built and is correct wherever the gateway
honors it. Withholding `s3:ListAllMyBuckets` is the remedy where it does not,
applied only to keys a scoped member mints, so an unscoped member's key is
unchanged. Neither reaches a key minted before scope existed, which is the
legacy transition (FIL-1020) and the reason scoping a member should prompt a
review of the keys they already hold (FIL-1021).

Because Aurora and FTH keys cannot be narrowed after issue, whichever option a
region needs has to be right at creation time. A key minted under a wrong
assumption is corrected by revoking and replacing it, never by editing it.

**Bind the behavior in the contract.** The Management API spec is how a new
orchestrator is held to a promise, and it currently promises nothing here. It
should say that a key with a non-empty `buckets` array lists only those buckets,
and each of the three gateways should be tested against that sentence before
this design is accepted. Forge is ours; FTH and Aurora are vendor questions with
lead time, which is why they go out early.
## 8. Bucket lifecycle leaves the S3 API

Bucket creation and deletion are S3 operations on every backend, not Management
API calls. The console performs them with the tenant's `filone-console`
credential (`createBucket` and `deleteBucket` are data-plane methods on every
orchestrator), and a user key carrying `s3:CreateBucket` or `s3:DeleteBucket`
performs the identical operation without FilOne seeing it. Nothing reports it
afterwards: the Management API has six paths and none of them is an event or
audit surface, an S3 `ListBuckets` returns a name and a creation date, and no
contract exposes which access key acted.

Three parts of this design rest on observing that lifecycle. The §5 auto-grant
fires only for console creations. The §5 sweep sees only console deletions. And
a name recreated out of band silently matches whatever grants the old bucket
left behind.

**The proposal: stop issuing `CreateBucket` and `DeleteBucket` on user keys, in
every region, until an orchestrator can report that a bucket's lifecycle changed
and which key changed it.** The `filone-console` key keeps both actions, so the
console's own bucket lifecycle is untouched. What goes away is a customer
credential creating or deleting a bucket. Bucket lifecycle then passes through a
FilOne handler by construction, which is what makes the grant write, the sweep,
and an audit event possible at all.

The change is small and reversible: `BUCKET_PERMISSIONS`
(`packages/shared/src/api/access-keys.ts`) stops being offered,
`CreateAccessKeySchema` refuses the two values, the console drops the two
checkboxes, and `supportsBucketManagement` — which today only excludes the
Aurora region — has nothing left to gate. Re-enabling is the same edit
backwards, with no migration either way.

**What it costs.** Customers scripting bucket lifecycle against the S3 API lose
that, and it is a capability the product ships today in the FTH and Forge
regions. Keys already carrying the two permissions keep them until revoked, so
the proposal is only as complete as the legacy transition that retires them
(FIL-1020).

**Aurora already does this.** `supportsBucketManagement` withholds both
permissions in the Aurora region, and FIL-1019 records the same fact from the
vendor side. So the proposal generalizes a policy one of the three backends
already runs under, rather than inventing one, and it moves the product toward
the uniform-regions answer to FIL-1024's open question of whether capabilities
should differ by region at all.

**What lifts it.** An orchestrator surface reporting bucket lifecycle with the
acting `accessKeyId`. On Forge that is the same Hilt work the rest of M3 needs
(FIL-918's permission read-back); on Aurora and FTH it is a vendor ask. It is
the same ask that closes the `ListBuckets` question in §7, which is the
argument for putting them in one message rather than three.

## 9. Lifecycle

**A scope is assigned at invite**, and edited afterwards (FIL-1017). At invite
time there is no `userId` to key a grant row on, so the invitation row carries
the intended scope inline: `bucketScope` plus a list of `{region}/{bucketName}`
entries on `ORG#{orgId}/INVITE#{inviteId}`. A list is right here for the reason
it was wrong on the membership row (§1's alternatives): the invitation is
written once by one admin, read once on accept, expires in 14 days, and is
never on a request path.

Acceptance materializes it. M1's accept is already one `TransactWriteItems`,
and an arbitrary number of grant rows cannot join it against the 100-item
transaction limit, so the membership lands first with its `bucketScope` marker
and the grants follow. The order is what makes the failure safe: a member whose
marker says `'specific'` and whose grants have not been written yet sees no
bucket, and the invitation row survives acceptance (M1 keeps it for the audit
export rather than deleting it), so the scope it names is still there to
re-drive. The reverse order would show the invitee the whole org.

An invitation carrying a role of Owner or Admin carries no scope, for the same
reason §2 ignores one on a membership: the role already sees everything, and an
Admin can edit their own scope anyway. The invite form offers the picker only
for the two roles it applies to.

**Revoking a grant** deletes both rows in one transaction and binds on the next
request. It is not, on its own, the whole operation: a member's existing keys
may still name the bucket, and FIL-1017 asks for no silent narrowing and no
silent survival. So narrowing a scope through
`PATCH /api/org/members/{userId}` computes that member's non-conforming keys
server-side and refuses the change without an explicit confirmation, answering
with the list. Confirmed, one flow revokes the keys and writes the scope.

Non-conformance is a local read. Both key kinds record `createdBy` and their
own `bucketScope` and `buckets` (`packages/shared/src/api/access-keys.ts`,
`lib/rag-api-keys.ts`), so the member's keys that hold `'all'`, or name a bucket
the new scope does not, are found without asking a vendor. Revocation itself is
the existing delete path, and how fast it binds at the provider is what FIL-1018
is still asking vendors; this document publishes no number for it. The console's
own cached bucket list survives until the next refetch, the same exposure the M1
ledger records for a narrowed role.

Member removal revokes keys the same way, which is FIL-1021's flow rather than
this one's.

**Removing a member** leaves grants behind. They are unbounded, so they cannot
join the transaction that deletes the membership and its inverse item, and they
are swept after it. An orphaned grant grants nothing on its own, because
`authorize()` refuses a caller with no membership row before any handler runs,
but it would revive if the same user rejoined the org. The sweep is what stops
that, and `deletion-scrub.ts` learns the new table so a missed sweep is still
collected.

**A scope survives promotion.** Promoting a scoped member to Admin or Owner
leaves `bucketScope` and every grant row exactly as they are; the new role
simply means nothing reads them. The same holds for widening a Member to
`'all'` without a role change. Only an explicit revoke deletes a grant.

Enforcing a scope against an Admin would protect nothing in any case: an Admin
holds `members.manage`, whose ceiling is Admin and below, so they can edit their
own scope in one request. What retention buys is the way back down. Demoting
someone six months later opens the scope editor with their retained grants
already selected, so the admin adjusts a real starting point and confirms, and
the common case writes one attribute because the rows are already there.
Clearing on promotion would instead return that member as an unrestricted one,
which is the opposite of what a demotion is for.

Pre-selection shows what was retained, which is nothing for a member who has
never been scoped. Buckets an unscoped member created meanwhile are not
recorded as grants — decision 4 writes a grant only for a member who is scoped
at the time — so the editor does not pretend to reconstruct a scope from what
somebody happened to touch.

The console says which of the two is in force, rendering an Admin's scope as
inactive rather than hiding it, and M1 already audit-logs the role change that
put it there.

**Deleting an org** reaches the new table through the members it already
enumerates: each member's grants are one partition, and the inverse rows go with
them.

## 10. Rollout

The M1 sequence applies unchanged: ship the table and the write path, backfill
`bucketScope: 'all'` onto every membership row under `sst shell` with a dry run
and a verify pass, confirm the stamp, then ship enforcement with the
absent-means-all fallback removed. Until an Owner or Admin scopes somebody,
nothing observable changes, which is what lets the enforcement PR merge
independently.

The table ships with point-in-time recovery, the way `OrgTable` did, and with an
IAM grant narrowed to the operations the handlers perform rather than the shared
`allResources` link. The account-deletion teardown and `deletion-scrub.ts` are
wired to it in the same PR that creates it, before any row exists, so no
migration is needed later.

The console surface is a scope editor on the members page (a per-region bucket
picker, populated from the admin's own unscoped `ListBuckets`) and an access
list on the bucket detail page, fed by the inverse partition. Both sit behind
the `ORGS_BETA` row pattern (`lib/orgs-beta.ts`), where granting is a row rather
than a redeploy.

## Open questions

1. **Does BFF enforcement end on Aurora and FTH?** Decision 1 accepts that
   `filone-console` addresses every bucket in the tenant. M3 is direct-key
   enforcement on Forge (FIL-1025, on FIL-918), which leaves the other two
   regions where §3 puts them unless a vendor answers. Whether they ever reach
   parity is the "parity vs Forge-first" decision the M3 milestone is gated on,
   and it decides whether any of §3 is temporary.
2. **Whether each gateway filters `ListBuckets` for a scoped key.** The
   requirement is settled (FIL-1017); §7's mechanism is not. It needs a test
   against each of the three gateways and a sentence in the Management API
   spec, since that spec is how a new orchestrator is bound. Forge answers
   quickly; FTH and Aurora are vendor questions with lead time, and the same
   message carries §8's lifecycle-reporting ask.
3. **Whether a deleted bucket's name stays reserved.** Neither the Management
   API contract nor the integration README says. If names are reserved, §5's
   stale grants are permanently inert. If they are reusable, the sweep is the
   only defense and §8 is what makes the sweep reachable. Same message as
   question 2.
4. **The tier split source.** Four M2 tickets cite a "2026-08-11 enforcement
   analysis" as their source, and the M1 ADR names it
   `iam-prd-enforceability-by-backend.md` in the knowledge-base repo. It
   defines the Tier 2 / Tier 3 vocabulary those tickets sort work by and is not
   in the knowledge-base clone on this machine. It should be read before this
   design is accepted.
