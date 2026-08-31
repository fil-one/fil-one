# Bucket policies (IAM M2, FIL-1017)

**Status:** Draft (design exploration, awaiting acceptance) **Created:**
2026-08-26 **Builds on:**
[`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md)

## Context

An Owner or Admin gives a member access to a subset of the tenant's buckets, or
to all of them, and a member holding access to a subset sees and interacts with
only that set. Console API routes therefore return results for that set alone and
the console renders what it gets. Access here is whole buckets; a prefix inside a
bucket is a later milestone.

**The access key's `buckets` array is the only bucket-scoping primitive any
Service Orchestrator exposes.** It is `CreateAccessKeyRequest.buckets` in the
Management API contract, the same field on Aurora's portal API, and the same on
FTH. There is no bucket ACL, no per-user bucket ownership, no ListBuckets filter,
and nothing that accepts a policy document. A design shaped by that primitive
alone gives an admin one checklist of bucket names per member, each maintained by
hand.

A **bucket policy** is the shape S3 customers already know: a named rule over one
region, a set of buckets in it, a permission set, and a roster of the org members
it applies to. An admin edits the rule once and every member on the roster moves
with it. Because no orchestrator
accepts a policy document, the rule is enforced in two places FilOne controls:
the console API on every request, and the permission set stamped onto an access
key when the key is issued.

The resemblance to S3 stops at the shape. A bucket policy here has no `Deny`, no
conditions, no principals outside the org, is not attached to the bucket, and
cannot be read back from the storage provider. Overlapping policies therefore
compose by union and only ever add access
([§3](#3-resolving-access-on-a-request)).

**FilOne stores no bucket records.** A bucket exists at the orchestrator and
nowhere else: `list-buckets.ts` fans out across provisioned regions and merges
what answers, and `get-bucket.ts` calls one orchestrator. A policy therefore names
buckets FilOne cannot validate locally, and it can outlive the buckets it names.
A bucket does have a stable identity: `(region, bucketName)`. Every
bucket-addressed route carries a region (`get-bucket.ts:30` defaults to
`S3_REGION`), `BucketSummary` carries one, and the RAG tables already key on
`BUCKET#{orgId}#{region}#{bucketName}` (`lib/dynamo-records.ts`). S3 bucket names
contain no `/`, so `{region}/{bucketName}` composes into a key unambiguously.

**A bucket can be deleted without FilOne learning.** On FTH and Forge, bucket
creation and deletion are S3 data-plane operations, so a customer's own access
key performs either one and nothing in the product records it. The Management
API has no event or audit surface, an S3 `ListBuckets` returns a name and a
creation date, and no contract exposes which key acted. Every tenant has that
exposure, whether or not any of its members are scoped, and closing it puts a
FilOne handler on every bucket creation and deletion
([§6](#6-bucket-lifecycle-moves-to-the-console)).

The caller's authorization state already arrives on the request, since M1 hands
handlers the membership row itself on `userInfo.membership`
(`lib/user-context.ts`). Key issuance already takes a permission set and a bucket
list too: `IssueAccessKeyOpts` is honored by all three orchestrators
(`fth-orchestrator.ts:228`, `aurora-orchestrator.ts:199`,
`orchestrator/orchestrator.ts:314`), and one key belongs to one region.

Enforcement has to live in the console API, because the console signs object
operations with one tenant-wide credential. `presign.ts` calls
`orchestrator.getS3ClientContext(tenantId)`, which resolves the per-tenant
`filone-console` key from SSM (`lib/s3-credentials.ts`), and that credential
addresses every bucket the tenant owns. Whatever the console refuses to sign is
the whole of the enforcement.

## Decision

1. **A bucket policy is the unit of bucket access.** One region, a set of buckets
   in it, a permission set, and a roster of org members
   ([§1](#1-what-a-bucket-policy-is)).
2. **A member's reach is the union of their policies.** Their permission on a
   bucket is the union of what every policy naming it grants, intersected with
   their role's permissions from the M1 matrix
   ([§3](#3-resolving-access-on-a-request)).
3. **Owner and Admin are unscoped by role**, and a membership row saying
   `bucketScope: 'all'` is unscoped. Policies apply to everybody else.
4. **Enforcement is the console API plus the key's permission set.** A handler
   refuses a request naming a bucket outside the caller's union, and orchestrator
   results are filtered against it on every request. The tenant-wide console
   credential and the keys already issued are not narrowed, which is M3's work.
5. **An access key is minted from exactly one policy**, taking all or part of its
   permissions and all or part of its buckets, and records the policy version it
   was issued under ([§4](#4-access-keys-minted-from-a-policy)).
6. **Editing a policy never edits an existing key.** No orchestrator can change a
   key's permissions in place, so a narrowing offers to revoke the keys it
   strands, and the offer is not taken by default
   ([§7](#7-policy-lifecycle)).
7. **Policies live in their own table**, one row per policy plus a roster row and
   its inverse, continuing M1's practice of splitting records into separate
   tables where the access pattern allows ([§2](#2-data-model)).
8. **Org-wide aggregates stay org-wide.** Usage, billing, and dashboard counts
   are not scoped ([§5](#5-what-a-scoped-member-can-still-see)).
9. **Enumeration over S3 is a name listing rather than an access boundary.** The
   key's `buckets` array governs what the key can operate on, which both measured
   backends enforce. Whether a gateway also filters `ListBuckets` is a contract
   item worth pursuing and nothing here depends on it
   ([§4](#4-access-keys-minted-from-a-policy)).
10. **`CreateBucket` and `DeleteBucket` come off customer access keys**, in every
    region, until an orchestrator can report a bucket's lifecycle and the key
    that changed it (FIL-1019). Every bucket's creation and deletion then runs
    through a FilOne handler, which is where the new bucket joins a policy and
    where the `bucket.created` and `bucket.deleted` events are appended
    ([§6](#6-bucket-lifecycle-moves-to-the-console)).

### 1. What a bucket policy is

A **bucket policy** belongs to an org and holds a name, one region, a set of
bucket names in that region, a permission set, and a roster. A policy holding no
buckets is valid: it keeps its roster and its permissions while an admin decides
what to point it at. Policy names need not be unique within an org, since the
policy id is the identity; the console warns on a collision rather than refusing
one.

The **roster** is the org members the policy applies to. A member can be on
several rosters, including two policies that name the same bucket.

The **version** is an integer on the policy row, bumped when the permission set
or the bucket set changes and left alone when the roster changes. It exists
because an access key records the version it was minted under, which is how the
console explains a key that does less than the policy now says.

The **effective permission** on a bucket, for a member, is the union of what
every policy of theirs naming that bucket grants, intersected with the
permissions their role holds in the M1 matrix. A Member on a read-only policy
cannot write that bucket.

**A ReadOnly member stays read-only whatever a policy grants them.** The role
holds `objects.read` and nothing that mutates, so the intersection leaves `read`
and `list` however wide the policy is: a ReadOnly member on a read-write policy
can open the bucket and browse its objects, and nothing more. A policy is also
the only route they have to a bucket, since ReadOnly is denied `keys.create` and
cannot mint a key.

A policy's permission vocabulary is thirteen of the fifteen values on an access
key: `read`, `write`, `list`, `delete`, `GetBucketVersioning`,
`GetBucketObjectLockConfiguration`, and the seven granular data-protection
permissions (`packages/shared/src/api/access-keys.ts`). `CreateBucket` and
`DeleteBucket` are excluded for two reasons. Decision 10 takes both off customer
keys in every region, and neither acts on a bucket a policy could name: a key
holding `CreateBucket` creates buckets outside its own policy. Bucket creation
stays where the M1 matrix already puts it, as the org-level `buckets.create`.
The two mutating granulars, `PutObjectRetention` and `PutObjectLegalHold`, keep
M1's rule unchanged: they require `privileged.grant`, which only an Owner holds,
whatever a policy lists.

### 2. Data model

Policies live in a new `BucketPolicyTable`, declared in `sst.config.ts` beside
the existing tables, `pk`/`sk` with no secondary index, following the house
pattern where a second access path is an inverse item. One attribute joins the
membership row in `OrgTable`.

| Table               | pk                              | sk                  | Attributes                                                                                                   | Purpose                                        |
| ------------------- | ------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `BucketPolicyTable` | `ORG#{orgId}`                   | `POLICY#{policyId}` | `name`, `region`, `buckets`, `permissions`, `granularPermissions`, `version`, `createdBy/At`, `updatedBy/At` | the policy                                     |
| `BucketPolicyTable` | `ORG#{orgId}#POLICY#{policyId}` | `MEMBER#{userId}`   | `addedBy`, `addedAt`                                                                                         | the roster                                     |
| `BucketPolicyTable` | `ORG#{orgId}#MEMBER#{userId}`   | `POLICY#{policyId}` | `addedBy`, `addedAt`                                                                                         | inverse: a member's policies, the request read |
| `OrgTable`          | `ORG#{orgId}`                   | `MEMBER#{userId}`   | `bucketScope`                                                                                                | whether policies apply                         |

**Buckets ride on the policy row as a list**, so adding or removing a bucket is
one conditional update to one row rather than a fan-out. The list is bounded by
what a region holds and by the 400KB item limit, which no tenant approaches, and
the row is read only by an admin surface or by a scoped caller resolving their
access. The bucket detail page's "which policies name this bucket" is answered by
querying the org's policies and filtering in memory, since policies per org is a
small number and that page is not a request path. An inverse item per bucket
would be a fourth row family to keep consistent.

**A roster change writes two rows in one `TransactWriteItems`**, the roster row
and its inverse, the way M1 keeps membership and its inverse item consistent.
Policy creation writes the policy row and its audit event in one transaction and
adds the roster as a following step, because an arbitrary roster cannot join a
100-item transaction. The order makes the failure safe: a policy whose roster has
not been written yet applies to nobody, and it fails closed.

**Reads on the request path carry `ConsistentRead`**, for the reason
`org-membership.ts` gives for the role read: an access-control read must not see
a stale replica. Removing somebody from a policy has to bind on their next
request.

**`bucketScope` stays on the membership row, which keeps the common case free.**
An empty policy set is ambiguous between "unscoped" and "scoped to nothing", and
resolving that from the policy table would put a Query on every request just to
learn that most callers are unscoped. `authMiddleware` already reads the
membership row, so `bucketScope: 'all'` answers with no I/O at all, and only a
scoped caller on a bucket-addressed route reads the policy table. `'specific'`
with no policies is a member who sees no bucket, and it fails closed. Evaluating
`'all'` per request also means a bucket created after the marker was written is
inside the scope by definition.

**Policies get their own table** because they are unbounded per org and their
rosters are unbounded per policy. In `OrgTable` they would share the
`ORG#{orgId}` partition with the membership, invitation, and `META` rows that
every authenticated request already reads, concentrating a growing row count on
the hottest partition in the product.

During rollout, a membership row carrying no `bucketScope` means `'all'`, since
every row written before this work carries no marker and today every member sees
every bucket. The backfill stamps `'all'` on every row and the following PR
removes the fallback, the sequence M1 used for the role fallback
([`2026-08-organizations-roles-m1.md`
§2](./2026-08-organizations-roles-m1.md#2-roles-and-the-permission-registry)).

### 3. Resolving access on a request

The resolver is a lib module in the shape M1's `lib/key-scope.ts` takes for the
same problem one level up, except that this one does I/O:

```ts
export type BucketAccess =
  | { sees: 'all' }
  | { sees: 'policies'; buckets: Map<string, Set<AccessKeyPermission>> };
```

Owner and Admin are unscoped by role, a caller whose membership row says `'all'`
is unscoped, and everyone else resolves against their policies. An unscoped
caller's policy rows are never read, on any route, because the role and the
marker settle the answer before the table is reached. Nobody deletes them either,
since promoting a member out of a scope leaves their rosters in place
([§7](#7-policy-lifecycle)).

A scoped caller costs two reads: one `Query` on `ORG#{orgId}#MEMBER#{userId}` for
their policy ids, and one `BatchGetItem` on those policy rows. The handler unions
the results into the map above, keyed `{region}/{bucketName}`, and caches it for
the request. Both reads are bounded by policies-per-member, a number an admin
controls rather than one that grows with usage, and the map answers both questions
a route asks: is this bucket in reach, and with which permissions.

The check runs in the handler rather than in middleware, because `authorize()`
decides from the route manifest alone and the manifest cannot name a bucket,
while the bucket arrives in a path parameter or, for `POST /api/presign`, in
each element of the body. This is the `in-handler` requirement M1 already
defines for presign.

| Route                                                    | Scoped behavior                                                                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/buckets`                                       | filter the merged fan-out result to the resolved set                                                                        |
| `POST /api/buckets`                                      | allowed; the creator names one of their policies for the new bucket ([§6](#6-bucket-lifecycle-moves-to-the-console))        |
| `GET /api/buckets/{name}`                                | absent from the set gives the same 404 a missing bucket gives                                                               |
| `DELETE /api/buckets/{name}`                             | gated on `buckets.delete`, which only an unscoped caller holds                                                              |
| `GET /api/buckets/{name}/analytics`                      | 404                                                                                                                         |
| `GET \| POST /api/buckets/{name}/rag/enabled`            | 404                                                                                                                         |
| `POST /api/buckets/{name}/bulk-delete`                   | 404                                                                                                                         |
| `GET /api/bulk-delete-jobs/{jobId}`                      | the job row names its bucket; check that bucket, 404 otherwise                                                              |
| `GET /api/activity`                                      | filter the bucket entries to the resolved set                                                                               |
| `POST /api/presign`                                      | per operation, the bucket in the set and the effective permission for it; one denial refuses the batch                      |
| `POST /api/buckets/{name}/query` (bearer)                | the bearer branch resolves the key creator's membership row, so that member's live access applies                           |
| `POST /api/access-keys`                                  | a policy the caller is on, plus optional subsets; refused when they are on none ([§4](#4-access-keys-minted-from-a-policy)) |
| `POST /api/rag-api-keys`                                 | same cap                                                                                                                    |
| `POST /api/org/invitations`                              | carries the invited member's policy ids ([§7](#7-policy-lifecycle))                                                         |
| `PATCH /api/org/members/{userId}`                        | role changes; a demotion into a scope runs the narrowing flow ([§7](#7-policy-lifecycle))                                   |
| `GET \| POST /api/bucket-policies`                       | list and create, `policies.manage`                                                                                          |
| `GET \| PATCH \| DELETE /api/bucket-policies/{policyId}` | read, edit, delete, `policies.manage`                                                                                       |
| `POST \| DELETE /api/bucket-policies/{policyId}/members` | roster changes, `policies.manage`                                                                                           |

`policies.manage` is a new permission in `packages/shared/src/permissions.ts`,
held by Owner and Admin. Those are the two roles `members.manage` already sits
at, so nobody gains or loses an ability on the day it ships, and the permission
names what it governs, since editing a policy changes what everybody on its
roster reaches.

**An out-of-scope bucket answers exactly like a bucket that does not exist.**
Same status, same body, no new `ApiErrorCode`, since a distinct code would
confirm the bucket exists. That costs a worse message for a member whose access
was removed while their tab was open, who gets "Bucket not found" where "your
access was removed" would be truthful. Hiding and explaining are exclusive here,
and hiding is what the feature is.

`POST /api/presign` refuses the whole batch on one denial, per M1's rule. The
batch carries one `region` query parameter covering every operation
(`presign.ts:246`), so the handler resolves the caller's map once and checks each
operation's bucket and verb against it.

A queued bulk-delete job runs to completion, because the job row carries no
creator (`lib/bulk-delete-jobs.ts:90-100`) and the worker drains its queue after
the request returns. Removing somebody from a policy stops them reading the job's
status while their deletion finishes unannounced.

**Overlapping policies compose by union, which costs precision.** Two policies
naming the same bucket with different permissions give the member the stronger of
the two, the way S3 composes two matching `Allow` statements. An admin who
narrows one policy has therefore not narrowed the member if another of their
policies still grants what was removed. The console is also more permissive than
any single key minted from these policies, because a key comes from one policy
while the console sees the union. Both belong in the console copy beside the
policy editor.

### 4. Access keys minted from a policy

A key request names a policy and, optionally, a subset of its permissions and a
subset of its buckets:

- `policyId` supplies the region, so `region` leaves the request.
- `permissions` and `granularPermissions`, when present, must be subsets of the
  policy's. Absent means the policy's whole set.
- `buckets`, when present, must be a subset of the policy's. Absent means the
  policy's whole list.
- `bucketScope: 'all' | 'specific'` leaves `CreateAccessKeySchema` entirely. It
  was a tenant-wide claim and there is no longer a path to make one from a
  policy.

An unscoped creator (Owner, Admin, or a member marked `'all'`) mints from any
policy in the org, whether or not they are on its roster, since their own reach
already covers every bucket the policy could name. They may also name no policy
at all, and then the request carries `region` and an optional `buckets` list, the
shape it has today, producing a tenant-wide key when the list is empty. That is
the only way a tenant-wide key gets minted, and only an unscoped creator can mint
one.

A scoped creator mints only from a policy they are on. A scoped member on no
roster has no bucket to mint a key for, so `POST /api/access-keys` refuses,
naming the reason rather than answering a permission error: they hold
`keys.create` and there is nothing to point a key at. The one policy such a
member can bring into being is the one attached to a bucket they create
([§6](#6-bucket-lifecycle-moves-to-the-console)), which puts them on its roster
in the same request. Creating a policy any other way is `policies.manage`, and
they do not hold it.

**A ReadOnly member cannot mint a key at all**, per M1's matrix, so their policy
rosters govern the console alone.

**A requested permission has to appear in the policy's set and in the creator's
own console permissions** under M1's mapping, and a requested bucket has to
appear in the policy's list. M1 capped a new key's permissions at the creator's
console permissions and deferred the bucket half here. The narrower wins, and a
refusal names what was refused.

**Every key is a snapshot, and the key row is the record of it.** The row
records `policyId`, the `policyVersion` in force at issue, and its own permission
and bucket lists. Widening a policy does not widen the keys already minted from
it, and reaching a newly added bucket means minting a new key. The console says
so at creation and shows the divergence afterwards: issued under v2, policy now
at v4.

Aurora's keys are immutable and FTH has no key-update endpoint, so changing what
a key reaches means revoking it and issuing another under a new access key ID,
which breaks whatever client was using it. Forge gets out of that once FIL-918
lands, where a key narrows in place and a key read returns its effective
permissions from the enforcing system instead of from our record. The console
flow is then one flow with two regional outcomes (FIL-1017), a difference
FIL-1024's per-region matrix has to show.

**Both measured backends enforce the key's bucket list against object
operations.** Aurora and FTH were measured on staging (2026-08-26):

| Region                 | Refuses an out-of-scope object read | Lists only the key's buckets   |
| ---------------------- | ----------------------------------- | ------------------------------ |
| `eu-west-1` (Aurora)   | yes                                 | yes                            |
| `us-east-1` (FTH)      | yes                                 | no, the whole tenant came back |
| `eu-central-3` (Forge) | untested                            | yes                            |

A scoped key reading a bucket it does not name is refused, which is the property
the cap depends on. Whether Forge also refuses is unmeasured, and being ours an
unwanted answer there is a bug to fix; M3's direct-key enforcement (FIL-1025, on
FIL-918) is where the gateway reads a key's scope from the system enforcing it.

**Enumeration is a name listing rather than an access boundary.** `aws s3 ls`
reaches the storage gateway directly and never touches a FilOne handler, so the
route table above does nothing for it, and every key FilOne mints carries
`s3:ListAllMyBuckets` unconditionally (`ALWAYS_PERMISSIONS`,
`orchestrator/orchestrator.ts:497`; `FTH_ALWAYS_PERMISSIONS`,
`fth-orchestrator.ts:377`). On FTH a scoped key therefore lists every bucket in
the tenant. The output is names alone: that key cannot read, write, or delete an
object in a bucket it does not name, and the console shows the member nothing
outside their policies. `aws s3 ls` against AWS itself lists buckets the caller
cannot open, so a name in that output has never meant access.

The Management API contract should still say that a key with a non-empty
`buckets` array lists only those buckets, since `CreateAccessKeyRequest.buckets`
promises today only that the key "may only operate on these buckets" and says
nothing about what the key lists, and that sentence is how a new orchestrator is
bound. Aurora and Forge already behave that way. FTH's change request travels in
the message carrying the lifecycle-feed ask from
[§6](#6-bucket-lifecycle-moves-to-the-console). Nothing region-specific gets
built for it, and no part of this design's enforcement depends on the answer.

FIL-1017 asks for out-of-scope buckets to be "absent from console and from
ListBuckets on that member's keys". The console half is met in full. The
ListBuckets half is met in two of three regions and accepted as outstanding in
the third ([Open questions](#open-questions)).

A key minted before policies existed carries no bucket list, so it enumerates
tenant-wide everywhere. That is the legacy transition (FIL-1020) and the reason
scoping a member should prompt a review of the keys they already hold
(FIL-1021).

### 5. What a scoped member can still see

Decision 8 leaves the aggregates org-wide, so a scoped member can still learn
that other buckets exist. `GET /api/usage` and `/api/usage/trends` report
org-wide bytes and object counts, the dashboard's bucket count and key count are
org-wide totals, and `GET /api/billing` is org-wide by construction because the
subscription is the org's. Closing those means a per-bucket breakdown on each
aggregate, and then the numbers a scoped member sees stop matching the invoice.

Bucket names still reach a scoped member two other ways. `HeadBucket` against a
bucket outside their policies answers 403 instead of 404 on both measured
backends, so a member who guesses an exact name confirms it exists, and closing
that would need the gateway to lie about existence. On FTH, `aws s3 ls` with any
key returns every bucket in the tenant
([§4](#4-access-keys-minted-from-a-policy)). Neither is closed. `aws s3 ls`
against AWS lists names the caller cannot act on too.

Presigned URLs already issued stay valid until they expire, up to 7 days for
downloads (`handlers/presign.ts:40`), which is the real revocation bound for
object reads after a policy change. What a member's existing SigV4 keys reach is
a separate matter ([§4](#4-access-keys-minted-from-a-policy)).

The activity feed is scoped, because it names individual buckets.
`fetchBucketActivities` calls `orchestrator.listBuckets(tenantId)` in each
provisioned region and renders one `bucket.created` entry per bucket, carrying
the name (`handlers/get-activity.ts:136-166`), which hands every bucket name in
the org to every role. So the handler filters those entries against the same
resolved map `GET /api/buckets` uses. Key entries need no change, since M1
already narrows them by `createdBy` under `keys.manage_own`.

### 6. Bucket lifecycle moves to the console

**A bucket a member creates joins a policy in the same request.**
`POST /api/buckets` carries a policy for the new bucket: either the id of one the
creator is on, or a new policy to create with the creator as its first member.
The handler refuses a policy the creator is not on, or one in another region. An
unscoped creator names none, and the bucket is theirs to see the way every bucket
is.

Naming the policy explicitly puts the blast radius in front of the person
creating the bucket. Adding the bucket to every policy the creator is on would
grant it to everybody else on those rosters without anyone asking.

Creating a bucket is also the one path by which a scoped member reaches a first
policy. Policy creation is otherwise `policies.manage`, held by Owner and Admin,
so a member on no roster either waits for an admin to put them on one or creates
a bucket and gets the policy that comes with it. Until one of those happens they
see no bucket and can mint no key ([§4](#4-access-keys-minted-from-a-policy)).

The policy write happens **before** the orchestrator call and is undone if
creation fails. A policy naming a bucket that does not exist grants nothing, so
the pre-write is safe in a way the post-write is not: a write that fails after a
successful create leaves a member unable to see the bucket they just made. The
two steps cannot be one transaction, because the bucket lives at the vendor, so
what survives a failure is a bucket name left in a policy, inert until a bucket
of that name exists in that region.

**Bucket deletion removes the name from every policy that holds it.** The sweep
queries the org's policies, updates the ones naming the bucket, and bumps each
version. It is bounded by policies per org rather than by anything that grows
with usage, and it sits outside the delete's own atomicity.

A deleted name cannot currently be reclaimed on either measured Service
Orchestrator: FTH reports that `us-east-1` reserves the name, and `eu-west-1`
answers HTTP 409, "This bucket name is already taken". A stale bucket name left
in a policy is therefore inert today. Nothing in the Management API spec
requires that behavior, so either vendor could change its name policy without
breaking a promise. The sweep is there for that day. Forge is unmeasured ([Open
questions](#open-questions)).

**Customer keys stop carrying `CreateBucket` and `DeleteBucket` in every
region.** The `filone-console` key keeps both actions, so the console's own
bucket lifecycle is untouched. A customer credential can no longer create or
delete a bucket unobserved.

The two operations reach a different API surface at each Service Orchestrator. On
Aurora both are Portal API calls (`createAuroraBucket` and `deleteAuroraBucket`,
reached through `createPortalClient`), so only FilOne can make them and the
region has never had the exposure. On FTH and Forge they are S3 data-plane
operations: the console performs them with the tenant's `filone-console`
credential, and a user key carrying `s3:CreateBucket` or `s3:DeleteBucket`
performs the identical operation without FilOne seeing it. Aurora is built this
way today, so FTH and Forge would be matching a shipped region, and every region
then behaves the same way. That is one answer to FIL-1024's question of whether
capabilities should differ by region at all.

The change is small and reversible. `BUCKET_PERMISSIONS`
(`packages/shared/src/api/access-keys.ts`) stops being offered,
`CreateAccessKeySchema` refuses the two values, the console drops the two
checkboxes, and `supportsBucketManagement` is deleted with its callers, having
nothing left to gate. Re-enabling is the same edit backwards, with no migration
either way. A denied attempt answers with the vendor's `AccessDenied`, the S3
error FIL-1019's acceptance criteria ask for.

Customers scripting bucket lifecycle against the S3 API lose that capability. The
product ships it today in the FTH and Forge regions. The Console API is
session-authenticated, so no credential FilOne issues reaches `POST /api/buckets`
either, and scripted bucket lifecycle has no supported path until an orchestrator
reports lifecycle events and the permission can return. Keys already carrying the
two permissions keep them until FIL-1020 retires them. The console labels the two
as legacy on the keys that hold them, which gives FIL-1021's key review something
to act on.

With every create and delete passing through a handler, `bucket.created` and
`bucket.deleted` become writable for the first time. Each carries the acting
user, the region, the bucket name, and the timestamp, and the create event names
the policy the bucket joined.

### 7. Policy lifecycle

**Invite.** An invitation carries the policy ids the new member should join, on
the row M1 already writes at `ORG#{orgId}` / `INVITE#{inviteId}`, alongside the
`bucketScope` marker. Acceptance adds the member to whichever of those policies
still exist and reports the ones it skipped. An invitation is an intent rather
than a contract: a policy deleted during the 14-day window is an admin's
deliberate act, and failing the acceptance would punish the invitee for it.

Acceptance lands the membership first with its marker, and the roster rows
follow, since an arbitrary number of them cannot join M1's 100-item accept
transaction. That order makes the failure safe: a member whose marker says
`'specific'` and whose rosters have not been written yet sees no bucket, and the
invitation row survives acceptance, so the policies it names are still there to
re-drive. An Owner or Admin invitation carries no policies at all, since both
roles are unscoped.

**Removing a permission, removing a bucket, removing a member, or deleting a
policy all open the same dialog.** Each one ends with somebody holding a key that
reaches more than the policy now says.

The dialog lists the keys the change strands and offers to revoke them. **The
offer is not taken by default.** A key is a snapshot because no orchestrator can
edit one in place, so retention is the default the mechanism already produces
and revocation is a step an admin chooses per action. Confirming without the box
ticked leaves the keys alive and the divergence visible on the key list.

When the box is ticked, revoke at the vendor first and write the policy second.
Revocation is a vendor call, so the two steps cannot be one transaction, and that
order keeps a partial failure safe: a failed revoke leaves the policy and
the keys where the operation started, while writing the policy first would narrow
the console while a key still reaches the dropped bucket at the gateway.
Re-driving is safe as long as deleting an already-deleted key counts as success.

Finding the stranded keys is a local read. Both key kinds record `createdBy`, and
a key minted from a policy records `policyId`, its version, and its own
permission and bucket lists
(`packages/shared/src/api/access-keys.ts`, `lib/rag-api-keys.ts`). How fast a
revocation binds at the provider is what FIL-1018 is still asking vendors, and it
has no answer yet. The console's own cached bucket list survives until the next
refetch.

Keys minted before M1 have no owner and never will, so the dialog cannot list
them, and those are the keys a policy review most wants to see. The
dialog therefore carries the org's unattributed key count beside the named list,
so an admin reads "3 keys can be revoked, 7 keys in this org have no recorded
owner and are not checked" instead of a list that looks complete. Labelling those
keys and restricting them to Owners and Admins is FIL-1020.

**The bucket sweep is the one narrowing that stays silent.** When
[§6](#6-bucket-lifecycle-moves-to-the-console) removes a deleted bucket's name
from the policies holding it, the keys naming that bucket reach nothing, so there
is nothing to revoke and nobody to ask.

**Demotion** out of an unscoped role runs the narrowing flow, because demoting an
Admin to Member activates their rosters while the keys they minted while unscoped
are tenant-wide. The `PATCH /api/org/members/{userId}` response opens the policy
picker so the admin can put the demoted member where they belong; a member on no
roster sees no bucket, and that fails closed. Owner to Admin never triggers it,
and neither does a demotion into a retained marker of `'all'`.

**Promotion** leaves everything in place. The marker and every roster row stay as
they are, and the new role means nothing reads them. Enforcing a policy against
an Admin would protect nothing anyway, since an Admin holds `policies.manage` and
can add themselves to any policy in one request. Retention lets a later demotion
reuse the old rosters, and the console renders a promoted member's
policies as inactive rather than hiding them.

**Removing a member** from the org leaves roster rows behind, since they are
unbounded and cannot join the transaction that deletes the membership and its
inverse item, so a sweep follows it. An orphaned roster row grants nothing on its
own, because `authorize()` refuses a caller with no membership row, but it would
revive if that user rejoined the org, and `deletion-scrub.ts` learns the new table
so a missed sweep is still collected. Member removal revokes keys through
FIL-1021's flow instead of this one's.

**Deleting an org** reaches the new table through the members and policies it
already enumerates.

### 8. Audit events

M1 shipped the audit write path and closed its event list at
`member.role_changed` and `member.removed`. FIL-1022's first acceptance criterion
asks for membership changes including scope, so this feature adds the events
while FIL-1022's ADR owns the viewer, the retention, and the export.

Each admin action writes one event:

- `bucket_policy.created` — the name, region, buckets, and permissions.
- `bucket_policy.updated` — the new version and what changed, plus the ids of any
  keys revoked with it.
- `bucket_policy.deleted` — the policy as it stood, plus revoked key ids.
- `bucket_policy.members_changed` — the members added and removed, plus revoked
  key ids.

One event per action is the same rule that keeps a per-bucket `bucket.granted`
out of the design: a policy edit touching twenty members would otherwise write
twenty events, and the FIL-1022 viewer would show twenty rows for one click.
Replaying the policy events and the roster events together answers "what could
this person reach in March".

`member.scope_changed` survives for the `'all' | 'specific'` marker alone, since
that is a per-member fact no policy event carries. `member.invited` and
`invite.accepted` gain the policy ids, and `bucket.created` and `bucket.deleted`
are defined in [§6](#6-bucket-lifecycle-moves-to-the-console).

The event joins the `TransactWriteItems` that writes the policy row or the roster
rows, the way M1's `commitAudited` handles a pure-DynamoDB mutation. A narrowing
that revokes keys calls a vendor before writing anything local, so it takes M1's
intent-and-completion pattern instead, and a crash between the two leaves a
visible dangling intent instead of revoked keys with no record.

Denials are not logged. A scoped member hitting a bucket outside their policies
gets a 404, and one event per 404 turns the audit log into a traffic log.
FIL-1022 scopes itself to control-plane events, and request-level logging is
FIL-949.

### 9. Rollout

The M1 sequence applies unchanged: ship the table and the write path, backfill
`bucketScope: 'all'` onto every membership row under `sst shell` with a dry run
and a verify pass, confirm the stamp, then ship enforcement with the
absent-means-all fallback removed. No policy exists on day one, and until an
Owner or Admin creates one and puts somebody on it, nothing observable changes,
so the enforcement PR merges independently.

The table ships with point-in-time recovery, the way `OrgTable` did, and with an
IAM grant narrowed to the operations the handlers perform instead of the shared
`allResources` link. The account-deletion teardown and `deletion-scrub.ts` are
wired to it in the same PR that creates it, before any row exists.

The console surface is a **Bucket policies** page at org level, the only place a
policy is authored: its name, region, buckets, permissions, and roster in one
editor, with the narrowing dialog on save. Two read-only views feed off it, "which
policies name this bucket" on the bucket detail page and "which policies is this
person on" on the member detail page. A policy spans several buckets and several
members, and authoring it from a page that shows one of each invites an
accidental edit. All three sit behind the `ORGS_BETA` row pattern
(`lib/orgs-beta.ts`), where granting is a row instead of a redeploy.

The key creation form changes shape with it: pick a policy, then narrow its
permissions and buckets. The region comes from the policy and the region selector
goes, except on the unscoped path in [§4](#4-access-keys-minted-from-a-policy).

## Options considered

**A grant per member and bucket**, one row keyed `(member, bucket)` in a table of
its own, is the smallest thing that satisfies FIL-1017. It gives the request path
an O(1) `GetItem` on the exact key, needs no union, and needs no versioning,
since there is no shared object to version. It gives no rule an admin can edit
once. Twelve members sharing access to the same eight buckets are
ninety-six rows with no name and no shape, adding a bucket to the team means
twelve edits, and nothing records that the twelve belong together. The policy
costs a second read on the request path and buys the entity the console needs.

**Materializing the policies into per-member grant rows** keeps both: policies as
the authoring layer, expanded into `(member, bucket)` rows carrying the unioned
permissions, so the request path stays O(1). The write amplification rules it
out. A policy holding 50 buckets with 20 members is 1,000 projection
rows on every edit, a roster change rewrites a member's whole set, the bucket
sweep rewrites more, and each of those writes is a chance to drift from the
policies that are the source of truth. An access-control read that can silently
disagree with its own source is worse than a second round trip.

**One policy per bucket**, which is what S3 means by the term, maps exactly onto
one key: `buckets: [thatBucket]`, no subsetting, no intersection. It also means a
member with twenty buckets holds twenty credentials to rotate, and an admin
granting a team access to eight buckets writes eight policies with eight
identical rosters. A policy over a set of buckets in one region maps onto the key
format without loss, because the key already carries one flat permission set over
a bucket array.

**Intersection instead of union** across a member's overlapping policies would
let an admin narrow somebody by adding them to a restrictive policy. It also
means adding a member to a read-only policy silently removes a write they
already had, which is the opposite of what an admin adding a grant expects, and
it cannot be expressed on a key at all: `Deny` has no representation in the only
primitive the orchestrators offer. Allow-only and union is all the mechanism can
enforce end to end.

**A String Set on the membership row** (holding `{region}/{bucketName}` entries)
needs no new table and no read at all, since the scope arrives on the row
`authMiddleware` has already fetched. `ADD` and `DELETE` are atomic, and it caps
one member at roughly 14,000 entries against the 400KB item limit, which no
tenant approaches. But the row is read on **every** authenticated request at 1
RCU per 4KB, so a member scoped to a thousand buckets makes ~28KB, or 7 RCU, of
every request in the product, including the routes that never touch a bucket.

**Withholding `s3:ListAllMyBuckets` from a scoped member's keys** refuses
enumeration whatever the gateway does. It costs the command outright, since
`aws s3 ls` then answers `AccessDenied` and breaks tooling that enumerates before
it acts, and it is not generally available: on Aurora the action rides inside the
`Default` grant, so withholding it drops `s3:GetBucketLocation` with it and
`ListBuckets` is answered anyway. That is a working command traded for a list of
names the caller cannot act on, and a conditional branch in a permission set that
has none today.

**Reconciling policies against `ListBuckets` on read**, instead of removing the
two bucket permissions, would leave customer bucket lifecycle where it is and
repair the policy rows from what the orchestrator reports. Nothing available
supports it. A policy naming a bucket that no longer exists is already inert, so
the failure reconciliation has to catch is the reused name, which means telling an
original bucket from a recreation. No orchestrator exposes a stable bucket
identity: `BucketSummary` carries a name and a creation date, and a delete
followed by a recreate inside the polling interval defeats both. Reconciliation
becomes possible on the day a lifecycle feed exists, and that is the same day the
permission can return.

## Open questions

1. **Does console-mediated enforcement end on Aurora and FTH?** Decision 4
   accepts that `filone-console` addresses every bucket in the tenant. M3 is
   direct-key enforcement on Forge (FIL-1025, on FIL-918), which leaves the other
   regions where [§3](#3-resolving-access-on-a-request) puts them unless a vendor
   answers. Whether they ever reach parity is the "parity vs Forge-first"
   decision the M3 milestone is gated on, and it decides whether any of §3 is
   temporary.
2. **What Forge does with an out-of-scope object read, and whether it reserves a
   deleted name.** Forge already filters enumeration, so those two columns are
   the ones left to run, both against Forge unchanged. Being ours, an unwanted
   answer there is a bug to fix, which makes it the cheapest of the three to
   settle.
3. **Whether FIL-1017's ListBuckets criterion stands as written.** The ticket
   asks for out-of-scope buckets to be absent from `ListBuckets` on a member's
   keys, which Aurora and Forge deliver and FTH does not
   ([§4](#4-access-keys-minted-from-a-policy)). Since the output is names a member
   cannot act on, the criterion is met in substance and unmet in letter on one
   region. The ticket owner decides whether to relax it or to hold the release to
   FTH's change request, and this design ships either way.
4. **What returns bucket lifecycle to customer keys.** A feed carrying bucket
   creations and deletions, with the acting access key identified, on the two
   Service Orchestrators that need one. On Forge that is the same
   [Hilt](https://github.com/fil-forge/hilt) work the rest of M3 needs (FIL-918's
   permission read-back); on FTH it is a vendor ask. Aurora needs nothing, having
   never had the exposure. The feed alone would let policies be reconciled
   ([Options considered](#options-considered)); the acting key answers the
   unobserved deletion, and only both together put `CreateBucket` and
   `DeleteBucket` back on a customer key. The same message closes the
   `ListBuckets` question in [§4](#4-access-keys-minted-from-a-policy), so both
   asks should travel together.
5. **Does a RAG API key's own bucket list bind on a bearer query?** The bearer
   branch resolves the creator's membership, so their live policies apply
   ([§3](#3-resolving-access-on-a-request)), and the key row also records the
   policy and version it was minted with. Whether the query is checked against the
   intersection or against the creator's live access alone is unstated, and the
   two differ once a policy widens after the key was minted.
6. **Whether a policy should carry a prefix rather than a whole bucket.** A
   policy is the natural place to put one, since it already names a region and a
   permission set, and the key's `buckets` array cannot express it. Prefix scope
   is Tier 3 work and belongs to the Forge enforcement story (FIL-1018), and
   nothing here blocks it.

## References

- Tickets: FIL-1017 member bucket scope, FIL-1018 revocation timing at vendors
  and prefix enforcement, FIL-1019 privileged operations (the bucket-lifecycle
  half is decided here), FIL-1020 legacy key transition, FIL-1021 key review on
  scope change, FIL-1022 audit viewer, FIL-1024 per-region disclosure, FIL-1025
  M3 direct-key enforcement, FIL-918 Forge key update, FIL-949 request-level
  logging.
- [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md) for
  roles, the permission registry, the audit write path, and the backfill sequence
  this design follows.
- Staging measurement, 2026-08-26: `ListBuckets` conformance per region
  ([§4](#4-access-keys-minted-from-a-policy)).
- **The tier split source is missing.** Four M2 tickets cite a "2026-08-11
  enforcement analysis", which the M1 ADR names
  `iam-prd-enforceability-by-backend.md` in the knowledge-base repo. That repo
  holds 61 files at HEAD and none of them is it. The Tier 2 and Tier 3 vocabulary
  it defines sorts work across FIL-1017 through FIL-1024, so someone should find
  it or write it again. This design does not wait on it: §4 and §6 measured the
  backend behavior the tier split was there to decide.
