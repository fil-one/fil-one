# Member bucket scope (IAM M2, FIL-1017)

**Status:** Draft (design exploration, awaiting acceptance)
**Created:** 2026-08-26
**Builds on:** [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md)
**Ships after:** [`2026-08-privileged-operations-m2.md`](./2026-08-privileged-operations-m2.md) (FIL-1019)

## Context

An Owner or Admin gives a member access to a subset of the tenant's buckets,
or to all of them. A member holding a grant to a subset sees and interacts
with only that set.

Console API routes therefore return results only for that set, and the console
renders what it gets.

Scope here is whole buckets. Scoping a member to a prefix inside a bucket is
deferred to a later milestone.

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
`buckets` array (`packages/shared/src/api/access-keys.ts:159`). One key belongs
to one region, which the same request carries, and the names in the array are
names within it. The cap in [§6](#6-capping-what-a-scoped-member-can-mint) is a
comparison between two sets that both already exist, and the list it produces is
enforced against object operations at the gateway, measured rather than assumed
([§7](#7-listbuckets-over-s3)).

## Decisions

Six decisions shape this design:

1. **Bucket scope is enforced in the console API.** A handler refuses a request
   that names an out-of-scope bucket, and results returned by orchestrators
   (bucket list, bucket activity) are filtered against the caller's granted
   scope on every request. The tenant-wide console credential and the SigV4 keys
   already issued are not narrowed (deferred to M3).
2. **Member bucket grants get their own table**, continuing the practice M1
   introduced of splitting records into separate tables where the access pattern
   allows.
3. **One row per bucket grant.** Each grant is its own row rather than an entry
   in a list held as a property of one record.
4. **Bucket scope is not enforced on org-wide aggregates.** Usage, billing, and
   dashboard counts stay org-wide.
5. **A scoped member who creates a bucket is granted it in the same request.**
   Every other member's scope changes only when an Owner or Admin says so.
6. **Enumeration over S3 is filtered by the key's bucket list, in every
   region.** A key whose `buckets` array is non-empty lists only those buckets.
   The Management API spec is where that is written, and a gateway that does not
   do it is not conforming ([§7](#7-listbuckets-over-s3)).

## Prerequisites

**FIL-1019 ships first.** It takes `CreateBucket` and `DeleteBucket` off
customer keys, so every bucket's creation and deletion passes through a FilOne
handler. The auto-grant, the revocation sweep, and the bucket audit events all
depend on that ([§5](#5-buckets-that-appear-after-the-grant)).

## 1. Data model

Grants live in a new `BucketAccessTable`, declared in `sst.config.ts` beside the
existing tables. One additional attribute is added to the membership row in `OrgTable`.

| Table               | pk                                         | sk                      | Attributes               | Purpose                                      |
| ------------------- | ------------------------------------------ | ----------------------- | ------------------------ | -------------------------------------------- |
| `BucketAccessTable` | `ORG#{orgId}#MEMBER#{userId}`              | `{region}/{bucketName}` | `grantedBy`, `grantedAt` | the grant; a member's scope is one partition |
| `BucketAccessTable` | `ORG#{orgId}#BUCKET#{region}/{bucketName}` | `MEMBER#{userId}`       | `grantedBy`, `grantedAt` | inverse: who can see this bucket             |
| `OrgTable`          | `ORG#{orgId}`                              | `MEMBER#{userId}`       | `bucketScope`            | whether the grants apply                     |

`bucketScope` names two things in this product. On a membership row it is the
**member scope**, the set of buckets a person reaches in the console. On an
access-key row it is the **key scope**, the set a credential may operate on
(`ACCESS_KEY_BUCKET_SCOPES`). Both take the values `'all'` and `'specific'`.
[§6](#6-capping-what-a-scoped-member-can-mint) caps the second against the first.

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
for the role fallback
([`2026-08-organizations-roles-m1.md` §2](./2026-08-organizations-roles-m1.md#2-roles-and-the-permission-registry)).

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

## 2. Resolving a scope on a request

The resolver is a lib module, in the shape M1's `lib/key-scope.ts` takes for the
same problem one level up: a permission the handler ignores is a permission that
does not exist. The difference is that this one does I/O, so it is an async
resolver rather than a pure function.

```ts
export type BucketScope = { sees: 'all' } | { sees: 'specific'; orgId: string; userId: string };
```

`Owner` and `Admin` are unscoped by role; a caller whose membership row says
`'all'` is unscoped; everyone else is `specific`. An unscoped caller's grant rows
are not read, on any route, because the role and the marker settle the answer
before the table is reached. They are not deleted either. Widening a scope, and
promoting a member out of one, both leave the rows in place
([§8](#8-lifecycle)). Which read follows depends on the route:

- **`GET /api/buckets` and `GET /api/activity`** issue one `Query` on the
  member's partition and filter the merged fan-out result against it. The Query
  walks every page: the key-listing routes already carry a first-page-only bug
  on the M1 follow-up ledger, and a scope that silently truncates hides buckets
  a member was granted.
- **Every bucket-addressed route** issues one `GetItem` on the exact grant key.
  No Query, no list, O(1) per request.

The check runs in the handler rather than in middleware. `authorize()` decides
from the route manifest alone and the manifest cannot name a bucket; the bucket
arrives in a path parameter or, for `POST /api/presign`, in each element of the
body. This is the `in-handler` requirement M1 already defined for presign.

## 3. Where the check goes

| Route                                         | Scoped behavior                                                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/buckets`                            | filter the merged fan-out result to the granted set                                                                                           |
| `POST /api/buckets`                           | allowed; the new bucket is granted to the creator ([§5](#5-buckets-that-appear-after-the-grant))                                              |
| `GET /api/buckets/{name}`                     | no grant row gives the same 404 a missing bucket gives                                                                                        |
| `DELETE /api/buckets/{name}`                  | gated on `buckets.delete`, which only an unscoped caller holds ([§2](#2-resolving-a-scope-on-a-request))                                      |
| `GET /api/buckets/{name}/analytics`           | 404                                                                                                                                           |
| `GET \| POST /api/buckets/{name}/rag/enabled` | 404                                                                                                                                           |
| `POST /api/buckets/{name}/bulk-delete`        | 404                                                                                                                                           |
| `GET /api/bulk-delete-jobs/{jobId}`           | the job row names its bucket; check that bucket, 404 otherwise                                                                                |
| `GET /api/activity`                           | filter the bucket entries to the granted set ([§4](#4-what-stays-visible))                                                                    |
| `POST /api/presign`                           | check every operation's bucket; one denial refuses the batch                                                                                  |
| `POST /api/buckets/{name}/query` (bearer)     | the bearer branch resolves the key creator's membership row, so that member's current scope applies ([§2](#2-resolving-a-scope-on-a-request)) |
| `POST /api/access-keys`                       | requested key scope is capped at the creator's member scope ([§6](#6-capping-what-a-scoped-member-can-mint))                                  |
| `POST /api/rag-api-keys`                      | same cap                                                                                                                                      |
| `POST /api/org/invitations`                   | carries the invited member's scope, materialized on accept ([§8](#8-lifecycle))                                                               |
| `PATCH /api/org/members/{userId}`             | carries scope changes, and refuses a narrowing that strands keys ([§8](#8-lifecycle))                                                         |

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
containing a denied operation. The batch carries one `region` query parameter
covering every operation in it (`presign.ts:155`), so the check is that one
region against the distinct bucket names, and it is one `BatchGetItem` rather
than a read per element.

**A bulk-delete job already queued runs to completion.** The job row carries
`region` and `bucketName` and no creator (`lib/bulk-delete-jobs.ts:90-100`), and
the worker drains a queue after the request has returned. Revoking a grant stops
the member reading the job's status and leaves the deletion running, because the
Admin who narrowed the scope removed future access rather than the authorization
that existed when the job was submitted. The member loses the status page while
their deletion finishes, so nothing tells them it completed.

## 4. What stays visible

Decision 4 leaves the aggregates org-wide, so a scoped member can still learn
that other buckets exist:

- `GET /api/usage` and `/api/usage/trends` report org-wide bytes and object
  counts; the dashboard's bucket count and key count are org-wide totals.
- `GET /api/billing` is org-wide by construction: the subscription is the org's.
- Any SigV4 key the member already holds keeps its own authority, and no console
  check reaches it: the request lands at the gateway
  ([§7](#7-listbuckets-over-s3)).
- In a region whose gateway does not filter enumeration yet, a scoped member
  holding any key can list every bucket name in the org over S3. Object access
  is refused all the same, so what they learn is the names
  ([§7](#7-listbuckets-over-s3)).
- `HeadBucket` against a bucket outside the scope answers 403 rather than 404 on
  both measured backends, so a member who guesses an exact name confirms it
  exists. Confirming a name somebody already suspects is a far smaller thing
  than listing every name, and closing it would need the gateway to lie about
  existence, so it stays.
- Presigned URLs already issued stay valid until they expire, up to 7 days for
  downloads (`handlers/presign.ts:40`). That is the real revocation bound for
  object reads after a scope change, the same bound M1 records for role changes.

Closing the first two is a per-bucket breakdown on each aggregate, and the
numbers a scoped member sees then stop matching the invoice. Closing the third
is M3, and the fourth closes when every gateway filters. The last two stay as
they are.

**The activity feed names individual buckets, so it is scoped.**
`fetchBucketActivities` calls `orchestrator.listBuckets(tenantId)` in each
provisioned region and renders one `bucket.created` entry per bucket, carrying
the name (`handlers/get-activity.ts:136-166`). It is a live listing rendered as
history, which is why nothing deleted appears in it, and it hands every bucket
name in the org to every role. FIL-1017 asks for out-of-scope buckets to be
absent from the console, so the handler filters those entries against the same
grant Query `GET /api/buckets` runs. Key entries need no change: M1 already
narrows them by `createdBy` under `keys.manage_own`.

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

**Name reuse is the sharp edge, and only in some regions.** Delete a bucket,
create another with the same name, and every stale grant applies to the new
bucket. FilOne has no bucket identifier to bind a grant to, so `delete-bucket`
sweeps the grants through the inverse partition, which is what that row family
is for. The sweep is bounded by the org's member count rather than by anything
that grows with usage. It sits outside the delete's own atomicity, and a grant
it misses is a member seeing a bucket nobody gave them.

Whether the hazard exists at all was measured on staging. On `eu-west-1` a
recreate answers HTTP 409, "This bucket name is already taken", so a deleted
name outlives its bucket and a stale grant there is permanently inert. On
`us-east-1` the recreate succeeds, so the hazard is real and the sweep is what
stands against it. `eu-central-3` is untested. The sweep therefore ships for
every region rather than being tuned per region, because a name policy is a
vendor's to change and this design should not break when one does.

**Both halves of this section need the console to have performed the
operation.** FIL-1019 is what guarantees it: with `CreateBucket` and
`DeleteBucket` off customer keys, no bucket appears or disappears without a
FilOne handler running. That handler is where the auto-grant writes, where the
sweep runs, and where the `bucket.created` and `bucket.deleted` audit events
that ticket defines are appended. Keys minted before FIL-1019 keep the two
permissions until FIL-1020 retires them, and a bucket deleted with one of those
keys still leaves its grants behind.

## 6. Capping what a scoped member can mint

M1 caps a new key's _permissions_ at the creator's console permissions and
defers the bucket half to this milestone. With member scope in place:

- A creator whose member scope is `all` is unaffected.
- A scoped creator names buckets from their own grants **in the key's region**.
  A key belongs to one region and its `buckets` array holds bare names, so the
  handler filters the creator's grants to that region and then requires every
  requested name to appear. A bucket outside them is refused, naming the bucket.
  A member scoped across three regions mints three keys to cover their scope.
- A scoped creator cannot request `bucketScope: 'all'`. The console offers that
  choice only to unscoped callers, and the handler refuses it whatever the
  console sent. Materializing `'all'` into the creator's current grants would
  mint the same key while hiding what it reaches, and the member would read the
  key as following their access.

The list the cap produces does two jobs, since
[§7](#7-listbuckets-over-s3) makes it the enumeration filter as well as the
filter on object operations.

The key form's bucket picker filters on the selected region and clears its
selection when the region changes, so the form stops offering a combination the
handler will reject.

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
outcomes (FIL-1017): update the key on Forge, revoke and replace it elsewhere.
That difference is one of the rows FIL-1024's per-region matrix has to show.

## 7. ListBuckets over S3

`aws s3 ls` reaches the storage gateway directly and never touches a FilOne
handler, so [§3](#3-where-the-check-goes) does nothing for it. Every key FilOne
mints carries `s3:ListAllMyBuckets` unconditionally (`ALWAYS_PERMISSIONS`,
`orchestrator/orchestrator.ts:497`; `FTH_ALWAYS_PERMISSIONS`,
`fth-orchestrator.ts:377`), Aurora grants it inside its default permissions, and
the console renders it as a checked, disabled checkbox
(`docs/S3Considerations.md`). A scoped member holding any key can enumerate
every bucket in the org.

**The key's bucket list filters enumeration, in every region.** A key whose
`buckets` array is non-empty lists only those buckets, and an empty array is
tenant-wide. That is the rule already governing the key's object operations,
carried to the one operation the gateway answers without asking us. The
Management API spec is where it gets written: `CreateAccessKeyRequest.buckets`
promises only that the key "may only operate on these buckets", and the sentence
about what the key lists is missing. A gateway that does not filter is not
conforming rather than working differently, so this design has one mechanism and
a conformance question per region.

**The orchestrator APIs expose exactly one bucket-scoping primitive:** the
`buckets` array on an access key. It is `CreateAccessKeyRequest.buckets` in the
Management API contract, the same field on Aurora's portal API, and the same on
FTH. There is no bucket ACL, no per-user bucket ownership, and no ListBuckets
filter in any of the three. FTH's storage users come closest, since keys are
minted under one and FilOne creates a single `filone-console` user per tenant,
but a storage user carries no bucket scope of its own (`FthStorageUser`), the
generic Management API has no equivalent concept, and Aurora exposes none. A
per-member storage user would buy attribution rather than filtering. So the one
primitive has to carry enumeration too, which is what the rule above asks of it.

**The requirement is settled.** FIL-1017 asks for out-of-scope buckets to be
"absent from console and from ListBuckets on that member's keys", so filtered
enumeration is a stated acceptance criterion rather than a choice. No contract
says whether a key carrying both `s3:ListAllMyBuckets` and a non-empty `buckets`
array returns the whole tenant's buckets or only the named ones, so conformance
was measured on staging (2026-08-26):

| Region                 | Refuses an out-of-scope object read | Lists only the key's buckets   |
| ---------------------- | ----------------------------------- | ------------------------------ |
| `eu-west-1` (Aurora)   | yes                                 | yes                            |
| `us-east-1` (FTH)      | yes                                 | no, the whole tenant came back |
| `eu-central-3` (Forge) | untested                            | untested                       |

**The first column is the one this design rests on, and it holds.** A key's
bucket list is enforced against object operations on both measured backends: a
scoped key reading a bucket it does not name is refused, and a bucket the key
does name reads the same whether the key is scoped or not. Had that gone the
other way, the list would have constrained nothing a reader cares about and
[§6](#6-capping-what-a-scoped-member-can-mint)'s cap would have been decoration.
The second column is enumeration, a smaller problem than access would have been.

**Aurora conforms today.** A scoped key's `ListBuckets` there returns the key's
own list, so a scoped member's `aws s3 ls` shows exactly their buckets with
nothing built on our side.

**FTH does not, and the fix is a change request.** What FTH is asked for is the
contract sentence: a key with a non-empty `buckets` array lists only those
buckets. It goes out in the message that carries FIL-1019's lifecycle-reporting
ask. Until the filter lands, a scoped member on `us-east-1` holding
any key can still list every bucket name in the org. What leaks is the names:
that member cannot read, write or delete an object in a bucket their key does
not name, which is the first column, and the console shows them nothing outside
their scope. The gap is disclosed as an accepted cost
([§4](#4-what-stays-visible)), and nothing region-specific is built while it
stands, so the always-on permission set stays unconditional and there is no
branch to delete on the day FTH ships the filter.

**Forge has to conform too**, and being ours that is an implementation task
rather than a vendor ask. It lands with M3's direct-key enforcement (FIL-1025,
on FIL-918), where the gateway reads a key's scope from the system enforcing it.

Withholding `s3:ListAllMyBuckets` from a scoped member's keys was the
alternative, and it is not the rule. It refuses enumeration whatever the gateway
does, and it costs the command outright: `aws s3 ls` answers `AccessDenied` and
breaks tooling that enumerates before it acts. It is also not generally
available. On Aurora the action rides inside the `Default` grant, so withholding
it drops `s3:GetBucketLocation` with it and `ListBuckets` is answered anyway; on
FTH, omitting it turns `ListBuckets` into `AccessDenied` and changes nothing
else. That is a workaround shaped to one vendor, bought with a conditional
branch in a permission set that has none today. Filtering in the console cannot
reach it at all: the request lands at the gateway, and the console is not in
front of it.

Existence probing by name survives the rule, and is accepted rather than solved
([§4](#4-what-stays-visible)).

A key minted before scope existed carries no bucket list, so the rule reads it
as tenant-wide and it keeps enumerating everything after every region conforms.
That is the legacy transition (FIL-1020), and the reason scoping a member should
prompt a review of the keys they already hold (FIL-1021).

`CreateBucket` outside the key's list is FIL-1019's now: it takes
`s3:CreateBucket` off customer keys before this ships, so no key reaches a
gateway able to create a bucket its own list does not name.

FIL-1024's per-region disclosure then carries conformance rather than mechanism:
one row per region, saying whether its gateway filters enumeration yet.

## 8. Lifecycle

**A scope is assigned at invite**, and edited afterwards (FIL-1017). At invite
time there is no `userId` to key a grant row on, so the invitation row carries
the intended scope inline: `bucketScope` plus a list of `{region}/{bucketName}`
entries on the row M1 already writes at `ORG#{orgId}` / `INVITE#{inviteId}`. A
list is right here for the reason it was wrong on the membership row
([§1's alternatives](#alternatives)): the invitation is written once by one
admin, read once on accept, expires in 14 days, and is never on a request path.

Acceptance materializes it. M1's accept is already one `TransactWriteItems`,
and an arbitrary number of grant rows cannot join it against the 100-item
transaction limit, so the membership lands first with its `bucketScope` marker
and the grants follow. The order is what makes the failure safe: a member whose
marker says `'specific'` and whose grants have not been written yet sees no
bucket, and the invitation row survives acceptance (M1 keeps it for the audit
export rather than deleting it), so the scope it names is still there to
re-drive. The reverse order would show the invitee the whole org.

An invitation carrying a role of Owner or Admin carries no scope, for the same
reason [§2](#2-resolving-a-scope-on-a-request) ignores one on a membership: the
role already sees everything, and an Admin can edit their own scope anyway. The
invite form offers the picker only for the two roles it applies to.

**Revoking a grant** deletes both rows in one transaction and binds on the next
request. It is not, on its own, the whole operation: a member's existing keys
may still name the bucket, and FIL-1017 asks for no silent narrowing and no
silent survival. So narrowing a scope through
`PATCH /api/org/members/{userId}` computes that member's non-conforming keys
server-side and refuses the change without an explicit confirmation, answering
with the list. Confirmed, one flow revokes the keys and then writes the scope.
The key's creator is not notified: the confirming admin sees the list before the
keys go.

That order carries the guarantee. Revocation is a vendor call, so the two steps
cannot be one transaction and one of them fails first. Revoking first and
failing leaves the member holding their key and the scope they already had,
which is where the operation started. Writing the scope first and failing leaves
them narrowed in the console while their key still reaches the dropped bucket at
the gateway, which is the silent survival FIL-1017 refuses. Re-driving is safe
as long as deleting an already-deleted key counts as success, which is what
makes a failure partway through several keys recoverable rather than a
half-applied change.

**Demotion out of an unscoped role runs the same flow.** Demoting an Admin to
Member activates whatever scope that person retained, and the keys they minted
while unscoped hold `bucketScope: 'all'`, reaching buckets the console will stop
showing them. That is a narrowing under any reading of FIL-1017, so the role
change goes through the same confirmation and the same revoke, on the same
route. Owner to Admin never triggers it, because
[§2](#2-resolving-a-scope-on-a-request) leaves both roles unscoped. A demotion
into a retained scope of `'all'` skips it for the same reason.

Non-conformance is a local read. Both key kinds record `createdBy` and their
own `bucketScope` and `buckets` (`packages/shared/src/api/access-keys.ts`,
`lib/rag-api-keys.ts`), so the member's keys that hold `'all'`, or name a bucket
in the key's region that the new scope does not, are found without asking a
vendor. Revocation itself is the existing delete path, and how fast it binds at
the provider is what FIL-1018 is still asking vendors; this document publishes
no number for it. The console's own cached bucket list survives until the next
refetch, the same exposure the M1 ledger records for a narrowed role.

**Keys minted before M1 have no owner and never will**, which M1 states as a
property of the backfill rather than a gap to close. Nothing ties them to a
member, so the confirmation dialog cannot list them, and the cohort it cannot
list is the one a scope review most wants: keys held by people who predate
roles. The dialog therefore carries the org's unattributed key count beside the
named list, so an Admin confirming a revoke reads "3 keys will be revoked, 7
keys in this org have no recorded owner and are not checked" instead of a list
that looks complete. Labelling those keys and restricting them to Owners and
Admins is FIL-1020.

**The scope editor sends deltas, never a replacement set.** The picker is
populated from the admin's own unscoped `ListBuckets`, and a grant can be
missing from it three ways: the bucket was deleted with a key that still carries
`DeleteBucket` and no sweep ran, a console delete's sweep failed partway, or the
region is down and `list-buckets` reported it in `unavailableRegions` while
returning nothing from it (`list-buckets.ts:57-64`). If saving the editor
deleted every grant not ticked, one save during a `us-east-1` outage would
revoke that member's whole `us-east-1` scope in silence. So the request names the
buckets granted and the buckets revoked, and the handler writes those. An
unavailable region renders as a disabled section reading "unavailable, N grants
unchanged". A grant whose bucket is gone from a healthy region renders as a
stale entry with a clear action, since that is the sweep's miss and an admin
clearing it is the repair.

An empty scope saves. A member with `'specific'` and no grants sees no bucket,
and suspending someone's access without removing them from the org is a real
thing to want, so the dialog says the member will see nothing rather than
refusing.

**Removing a member** leaves grants behind. They are unbounded, so they cannot
join the transaction that deletes the membership and its inverse item, and they
are swept after it. An orphaned grant grants nothing on its own, because
`authorize()` refuses a caller with no membership row before any handler runs,
but it would revive if the same user rejoined the org. The sweep is what stops
that, and `deletion-scrub.ts` learns the new table so a missed sweep is still
collected. Member removal revokes keys through FIL-1021's flow rather than this
one's.

**A scope survives promotion.** Promoting a scoped member to Admin or Owner
leaves `bucketScope` and every grant row exactly as they are; the new role
simply means nothing reads them. The same holds for widening a Member to
`'all'` without a role change. Within a scope change, only an explicit revoke
deletes a grant.

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
recorded as grants, because decision 5 writes a grant only for a member who is
scoped at the time, so the editor does not pretend to reconstruct a scope from
what somebody happened to touch.

The console says which of the two is in force, rendering an Admin's scope as
inactive rather than hiding it, and M1 already audit-logs the role change that
put it there.

**Deleting an org** reaches the new table through the members it already
enumerates: each member's grants are one partition, and the inverse rows go with
them.

## 9. What this records

M1 shipped the audit write path and closed its event list at
`member.role_changed` and `member.removed`. FIL-1022's first acceptance
criterion asks for membership changes including scope, so this feature adds the
events and FIL-1022's ADR owns the viewer, the retention, and the export.

**One event per admin action, not one per bucket.** `member.scope_changed`
carries the marker before and after, the granted and revoked bucket keys, and
the ids of any keys revoked with it. A per-bucket `bucket.granted` would flood
the FIL-1022 viewer with a row per checkbox and multiply the items in a
transaction that is already bounded at 100.

`member.invited` and `invite.accepted` gain the scope, since
[§8](#8-lifecycle) puts it on the invitation row and materializes it on accept.

**The write follows the shape of the mutation.** The event joins the
`TransactWriteItems` that writes the `bucketScope` marker, the way M1's
`commitAudited` handles a pure-DynamoDB mutation, and the grant rows follow
outside it for the transaction-limit reason [§8](#8-lifecycle) gives. The
narrowing flow is a different case: it calls a vendor to revoke keys before
writing anything local, so it takes M1's intent-and-completion pattern instead,
for the same reason `create-access-key` does. A crash between the two leaves a
visible dangling intent rather than revoked keys with no record.

`bucket.created` and `bucket.deleted` belong to FIL-1019, which is the work that
makes them writable at all.

**Denials are not logged.** A scoped member hitting an out-of-scope bucket gets
a 404, and one event per 404 turns the audit log into a traffic log. FIL-1022
scopes itself to control-plane events, and request-level logging is FIL-949.

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
picker with the delta and unavailable-region behavior in [§8](#8-lifecycle)) and
an access list on the bucket detail page, fed by the inverse partition. Both sit
behind the `ORGS_BETA` row pattern (`lib/orgs-beta.ts`), where granting is a row
rather than a redeploy.

## Open questions

1. **Does console-mediated enforcement end on Aurora and FTH?** Decision 1
   accepts that `filone-console` addresses every bucket in the tenant. M3 is
   direct-key enforcement on Forge (FIL-1025, on FIL-918), which leaves the other
   regions where [§3](#3-where-the-check-goes) puts them unless a vendor answers.
   Whether they ever reach parity is the "parity vs Forge-first" decision the M3
   milestone is gated on, and it decides whether any of
   [§3](#3-where-the-check-goes) is temporary.
2. **What Forge does today with enumeration and with a reused name.** It has to
   filter either way, so this is a measurement rather than a decision. Both runs
   go against Forge unchanged
   ([§5](#5-buckets-that-appear-after-the-grant),
   [§7](#7-listbuckets-over-s3)). Being ours, an unwanted answer there is a bug
   to fix rather than a vendor ask, which makes it the cheapest of the three to
   settle.
3. **Whether FTH will filter `ListBuckets` by the key's bucket list.** This is
   the one open dependency in [§7](#7-listbuckets-over-s3), and it needs an owner
   for the FTH relationship rather than an engineering decision, since nothing is
   built here either way. What is needed is the spec sentence accepted and
   implemented; what would settle it is a date. Until then a scoped member on
   `us-east-1` can enumerate names they cannot read.
4. **What the contract says about a deleted bucket name.** Aurora reserves the
   name and FTH releases it, and nothing in the Management API spec requires
   either, so both could change without a vendor breaking a promise. That
   silence is why the sweep in
   [§5](#5-buckets-that-appear-after-the-grant) ships for every region; a
   contract sentence would make it something to reason about instead.
5. **The tier split source is missing.** Four M2 tickets cite a "2026-08-11
   enforcement analysis", which the M1 ADR names
   `iam-prd-enforceability-by-backend.md` in the knowledge-base repo. That repo
   holds 61 files at HEAD and none of them is it. The Tier 2 and Tier 3
   vocabulary it defines sorts work across FIL-1017 through FIL-1024, so someone
   should find it or write it again. This design does not wait on it:
   [§5](#5-buckets-that-appear-after-the-grant) and
   [§7](#7-listbuckets-over-s3) measured the backend behavior the tier split was
   there to decide, and Forge stays untested either way.
6. **Does a RAG API key's own bucket list bind on a bearer query?** The bearer
   branch resolves the creator's membership, so their current scope applies
   ([§3](#3-where-the-check-goes)), and the key row also records the scope it was
   minted with. Whether the query is checked against the intersection or against
   the creator's live scope alone is unstated, and the two differ once the
   creator's scope widens after the key was minted.
