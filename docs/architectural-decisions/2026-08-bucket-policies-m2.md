# Bucket policies (IAM M2, FIL-1017)

**Status:** Draft (design exploration, awaiting acceptance) **Created:**
2026-08-26 **Builds on:**
[`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md)

## Context

An Owner or Admin gives a member access to a subset of the tenant's buckets, or
to all of them, and a member holding access to a subset sees and interacts with
only that set. Console API routes return results for that set alone and the
console renders what it gets. Access here is whole buckets; a prefix inside a
bucket is a later milestone.

A **bucket policy** is a property of one bucket, holding a list of statements
that say which members may do what to it. That is the shape S3 customers already
know, and the routes that read and write it are the ones they already know:
`GetBucketPolicy`, `PutBucketPolicy`, `DeleteBucketPolicy`. The resemblance has
limits. A policy here names principals inside the org only, carries no
conditions, and cannot be read back from the storage provider, because no
Service Orchestrator accepts a policy document. The rule is enforced in two
places FilOne controls: the console API on every request, and the grant stamped
onto an access key when the key is issued.

**An access key belongs to a member.** It carries whatever that member's
policies grant in its region, computed at issue, and the person minting it
chooses nothing about the grant. That is how AWS works, and it is the property
that makes a policy edit meaningful: changing what a member reaches has to
change what their credentials reach, or the policy describes the console alone.

**The vendor primitive is one flat permission set over one bucket array.**
`CreateAccessKeyRequest.buckets` is the only bucket-scoping field any Service
Orchestrator exposes, and it is the same field on Aurora's portal API and on
FTH. A member holding read on one bucket and write on another cannot be
expressed on one key. The grant rounds up to the union across their buckets, so
a key can write a bucket its policy allows only for reading. The over-grant is
bounded by the member's own buckets, the console refuses what the policies
refuse, and it ends on Forge when enforcement moves into the storage system
(FIL-1025, on FIL-918). One policy per bucket makes buckets carrying different
permissions ordinary, so this fires routinely.

**FilOne stores no bucket records.** A bucket exists at the orchestrator and
nowhere else: `list-buckets.ts` fans out across provisioned regions and
concatenates what answers (`list-buckets.ts:60-64`), and `get-bucket.ts` calls
one orchestrator. A bucket does have a stable identity, `(region, bucketName)`.
Every bucket-addressed route carries a region, `BucketSummary` carries one
alongside a creation timestamp (`lib/service-orchestrator.ts:36-41`), and the
RAG tables already key on `BUCKET#{orgId}#{region}#{bucketName}`
(`lib/dynamo-records.ts`). The region is part of the identity: nothing prevents
the same tenant from holding `logs` in two regions. `create-bucket.ts:57-62`
resolves one orchestrator for the requested region and creates there, and
uniqueness is enforced by that provider inside that region alone
(`lib/s3-bucket-operations.ts:23-36`, `lib/aurora/aurora-portal.ts:96`).

**A bucket can be deleted without FilOne learning.** On FTH and Forge, bucket
creation and deletion are S3 data-plane operations, so a customer's own access
key performs either one and nothing in the product records it. A policy is
addressed by the bucket it belongs to, so a name that can be deleted unobserved
and later reclaimed is a policy that can attach to a bucket nobody intended.
Closing that puts a FilOne handler on every bucket creation and deletion
([§6](#6-bucket-lifecycle-moves-to-the-console)).

**Aurora and FTH model a tenant plus key-scoped permissions, and the product
models users.** Neither vendor has a policy document, and only FTH has a user
object. The gap between the two models has to be written somewhere, and where it
lives decides what M3 costs. Above the Service Orchestrator interface, moving
enforcement into Forge means pushing the console's policy state into the system
enforcing it, a sync channel that can drift. Behind the interface, Forge swaps
the shared store for [Hilt](https://github.com/fil-forge/hilt) and keeps no rows
([§10](#10-the-service-orchestrator-interface)).

Console-side enforcement is the other half, because the console signs object
operations with one tenant-wide credential. `presign.ts` calls
`orchestrator.getS3ClientContext(tenantId)`, which resolves the per-tenant
`filone-console` key from SSM (`lib/s3-credentials.ts`), and that credential
addresses every bucket the tenant owns. Whatever the console refuses to sign is
the whole of the enforcement there.

## Decision

1. **A bucket policy belongs to one bucket** and is identified by
   `(region, bucketName)`. It holds a list of statements, each carrying an
   effect, a set of principals, and a set of actions
   ([§1](#1-what-a-bucket-policy-is)).
2. **A member's permission on a bucket** is the Allow statements naming them,
   minus the Deny statements naming them, intersected with the permissions their
   role holds in the M1 matrix ([§1](#1-what-a-bucket-policy-is)).
3. **Owner and Admin are unscoped by role**, and a membership row saying
   `bucketScope: 'all'` is unscoped. Policies apply to everybody else, and Deny
   does not reach an unscoped caller ([§3](#3-resolving-access-on-a-request)).
4. **A bucket with no policy is reachable by unscoped callers alone.** A scoped
   member sees it only when a statement names them, and `POST /api/buckets`
   writes a policy naming the creator
   ([§6](#6-bucket-lifecycle-moves-to-the-console)).
5. **An access key belongs to a member.** The request carries a name, a region,
   and an expiry; the grant is synthesized from the member's effective access in
   that region and nothing about it is the caller's to choose
   ([§4](#4-access-keys-belong-to-a-member)).
6. **Every change to a member's effective access re-syncs their keys.** A
   narrowing revokes the keys it strands unless the request names them to
   retain; a widening leaves keys in place, narrower than the member and marked
   as such ([§7](#7-policy-lifecycle)).
7. **The bucket-access domain lives behind the Service Orchestrator interface**,
   with one shared store the implementations compose and one capability,
   `keyGrantSync`, that the console branches on
   ([§10](#10-the-service-orchestrator-interface)).
8. **A scheduled pass reconciles buckets against policies.** It writes the
   default policy onto a bucket that has none, retires a policy whose bucket is
   gone, and re-syncs a member whose keys outrun their access
   ([§9](#9-rollout)).
9. **Org-wide aggregates stay org-wide.** Usage, billing, and dashboard counts
   are not scoped ([§5](#5-what-a-scoped-member-can-still-see)).
10. **Enumeration over S3 is a name listing rather than an access boundary.**
    The key's `buckets` array governs what the key can operate on, which both
    measured backends enforce. Whether a gateway also filters `ListBuckets` is a
    contract item nothing here depends on
    ([§4](#4-access-keys-belong-to-a-member)).
11. **`CreateBucket` and `DeleteBucket` come off customer access keys**, in
    every region, until an orchestrator can report a bucket's lifecycle and the
    key that changed it (FIL-1019). Every bucket's creation and deletion then
    runs through a FilOne handler, which is where its policy is written and
    retired ([§6](#6-bucket-lifecycle-moves-to-the-console)).

### 1. What a bucket policy is

A bucket policy holds a list of **statements**. Each statement carries an
`effect` of `Allow` or `Deny`, a set of `principals` (member ids, or `*` for
every member of the org), and a set of `actions`. The resource is the bucket the
policy belongs to and is not written down; it is the field that will carry a
prefix when prefix scope arrives.

The **effective permission** for a member is the union of the actions in the
Allow statements naming them, minus the union of the actions in the Deny
statements naming them, intersected with the permissions their role holds in the
M1 matrix. A member denied every action drops out of the bucket: 404 from the
console, and absent from the bucket array on any key they mint. A statement
naming a member who no longer exists grants and denies nothing, and the removal
sweep takes it out anyway ([§7](#7-policy-lifecycle)).

Statements compose inside one document and never across documents, because a
bucket has exactly one policy. An admin narrowing a bucket has narrowed
everybody it names, with no second document to check.

**Deny does not apply to an Owner, an Admin, or a member marked `'all'`.** All
three are unscoped and the policy store is never read for them. Enforcing a Deny
against an Admin would protect nothing, since `buckets.policy_manage` is the
permission that deletes the Deny and both roles hold it. The policy editor says
so where a Deny is written.

**A ReadOnly member stays read-only whatever a statement allows.** The role
holds `objects.read` and nothing that mutates, so the intersection leaves read
and list however wide the statement is. A policy is also the only route they
have to a bucket, since ReadOnly is denied `keys.create` and cannot mint a key.

A statement's action vocabulary is thirteen of the fifteen values on an access
key, plus one. The thirteen are `read`, `write`, `list`, `delete`,
`GetBucketVersioning`, `GetBucketObjectLockConfiguration`, and the seven
granular data-protection permissions (`packages/shared/src/api/access-keys.ts`).
`CreateBucket` and `DeleteBucket` are absent: Decision 11 takes both off
customer keys, and neither acts on a bucket a policy could name, since a key
holding `CreateBucket` creates buckets outside it. Bucket creation stays where
the M1 matrix puts it, as the org-level `buckets.create`.

The fourteenth is **`BypassGovernanceRetention`**, the action that overrides a
governance-mode retention lock. It is the S3 spelling of the capability
[`2026-08-privileged-operations-m2.md`](./2026-08-privileged-operations-m2.md)
scopes to a member, and a bucket policy statement is where AWS puts it, next to
`DeleteObject`. Naming it in a statement scopes it to one bucket and one set of
members instead of the whole org. No Service Orchestrator accepts the bypass
yet, so the action is disabled in the editor and cannot be granted until every
region supports it.

**A statement is how the two retention writes reach a member.**
`PutObjectRetention` and `PutObjectLegalHold` make an object undeletable for
years, and M1 restricted them to `privileged.grant`, a permission only the Owner
holds (`GRANULAR_ELEVATIONS`,
`packages/shared/src/access-key-permissions.ts:49-51`). Under this design that
restriction leaves them unreachable: an Owner is unscoped and takes their key's
permissions from the role, and every member who reads a statement is barred by
the ceiling from holding either action. So a statement naming one of them
**supplies the elevation for that bucket**, the way `privileged.grant` supplies
it org-wide, and the intersection in [§4](#4-access-keys-belong-to-a-member)
consults the statement for these two actions and the role for everything else.
The ceiling keeps its meaning for the other eleven.

Two conditions ride with that. **Writing such a statement takes
`privileged.grant`**, so an Owner can grant a retention write and an Admin
cannot. That is the boundary the M1 matrix draws, and this design does not move
it. And the statement must also grant `write` on the bucket, since a granular
narrows the object permission it hangs off (`GRANULAR_PERMISSION_MAP`); the
editor refuses the combination rather than saving a grant that would be dropped
at issue. `GRANULAR_ELEVATIONS`'s docstring states that a key is the only path
to these actions and that only an Owner can hold them, and both sentences stop
being true.

A member's reach spans regions because they are named in policies on buckets in
several. Each policy stays inside one region, since its bucket does.

### 2. Data model

Policies live in a new `BucketPolicyTable`, declared in `sst.config.ts` beside
the existing tables, `pk`/`sk` with no secondary index. One attribute joins the
membership row in `OrgTable`.

| Table               | pk            | sk                             | Attributes                                                                | Purpose                |
| ------------------- | ------------- | ------------------------------ | ------------------------------------------------------------------------- | ---------------------- |
| `BucketPolicyTable` | `ORG#{orgId}` | `POLICY#{region}#{bucketName}` | `statements`, `bucketCreatedAt`, `updatedAt`, `updatedBy`, `createdBy/At` | the policy             |
| `BucketPolicyTable` | `ORG#{orgId}` | `KEY#{region}#{keyId}`         | the stamped grant, `userId`, `createdBy`, `keyName`, `expiresAt`          | the key record         |
| `OrgTable`          | `ORG#{orgId}` | `MEMBER#{userId}`              | `bucketScope`                                                             | whether policies apply |

S3 bucket names contain no `#`, so the sort key composes unambiguously and a
`begins_with` on `POLICY#{region}#` returns one region's policies in a single
Query. Two row families in the new table, no inverse items.

**Statements ride on the policy row as a list**, so a policy is one item and a
write is one conditional update. The list is bounded by the members named on one
bucket, and a `*` principal collapses the common case to one entry. AWS caps a
bucket policy at 20KB against DynamoDB's 400KB item, so the ceiling is not a
constraint anybody meets.

**`bucketCreatedAt` records the creation timestamp `BucketSummary` reports for
the bucket the policy was written against.** It is what lets the reconciliation
pass tell an original bucket from a recreation that reused its name: a new
bucket carries a new timestamp whatever the interval was ([§9](#9-rollout)).

**`updatedAt` is the write condition.** `PUT` replaces the whole document, the
way `PutBucketPolicy` does, and conditions the write on the `updatedAt` the
caller read. Two admins editing the same bucket conflict instead of one losing
their edit silently. `previewPolicyChange` returns the value it read and the
mutation takes it as its condition, so a stale preview fails and the caller
re-reads ([§7](#7-policy-lifecycle)).

**Reads on the request path carry `ConsistentRead`**, for the reason
`org-membership.ts` gives for the role read: an access-control read must not see
a stale replica. Removing somebody from a policy has to bind on their next
request.

**`bucketScope` stays on the membership row, which keeps the common case free.**
An empty statement set is ambiguous between "unscoped" and "scoped to nothing",
and resolving that from the policy store would put a Query on the request path
just to learn that most callers are unscoped. `authMiddleware` already reads the
membership row, so `'all'` answers with no I/O, and only a scoped caller on a
bucket-addressed route reads the store. `'specific'` with no statement naming
them is a member who sees no bucket, and no request of theirs resolves to one.
Evaluating `'all'` per request also means a bucket created after the marker was
written is inside the scope by definition, so an admin can say "this member sees
everything, including what does not exist yet". Nothing a policy can say
expresses that, since a statement needs a bucket to live on.

**The store holds the domain.** `BucketPolicyTable`, the key records, and the
resolution logic are `lib/bucket-access`, a shared module all three orchestrator
implementations compose today ([§10](#10-the-service-orchestrator-interface)).
Key records move out of `UserInfoTable` into it, so a key read can answer with
effective permissions from the enforcing system on a region that has one. At M3,
Forge swaps the module for Hilt and keeps no rows.

**Policies get their own table** because they are unbounded per org. In
`OrgTable` they would share the `ORG#{orgId}` partition with the membership,
invitation, and `META` rows that every authenticated request already reads,
concentrating a growing row count on the busiest partition in the product.

The table ships with point-in-time recovery, the way `OrgTable` did, and with an
IAM grant narrowed to the operations the handlers perform instead of the shared
`allResources` link. The account-deletion teardown and `deletion-scrub.ts` are
wired to it in the PR that creates it, before any row exists.

### 3. Resolving access on a request

```ts
export type BucketAccess =
  | { sees: 'all' }
  | { sees: 'policies'; buckets: Map<string, Set<AccessKeyPermission>> };
```

The map is keyed `{region}/{bucketName}`, so the merged answer across regions is
one map and a handler holding a bucket and a region has one lookup. A tenant can
hold `logs` in two regions, and those are two buckets.

Owner and Admin resolve to `{ sees: 'all' }` from the role alone, and a caller
whose membership row says `'all'` resolves the same way from the marker. Neither
reads the policy store on any route. Everyone else resolves against the
statements naming them, and a member named in none reaches no bucket.

`resolveMemberAccess` sits behind a per-region orchestrator
([§10](#10-the-service-orchestrator-interface)), so a scoped member listing
buckets costs one Query per provisioned region, each
`begins_with POLICY#{region}#`, merged and evaluated in memory against the
fan-out the handler already performs for the names. Paging past 1MB is the same
paging `list-buckets.ts` already does. A scoped member addressing one bucket
costs one `GetItem` on that region's `POLICY#{region}#{bucketName}`. That is the
common case, and it is O(1). The map answers both questions a route asks: is
this bucket in reach, and with which permissions.

The check runs in the handler, because `authorize()` decides from the route
manifest alone and the manifest cannot name a bucket, while the bucket arrives
in a path parameter or, for `POST /api/presign`, in each element of the body.
This is the `in-handler` requirement M1 already defines for presign.

| Route                                             | Scoped behavior                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/buckets`                                | filter the merged fan-out result to the resolved set                                                     |
| `POST /api/buckets`                               | allowed; the handler writes the new bucket's policy ([§6](#6-bucket-lifecycle-moves-to-the-console))     |
| `GET /api/buckets/{name}`                         | absent from the set gives the same 404 a missing bucket gives                                            |
| `DELETE /api/buckets/{name}`                      | gated on `buckets.delete`, which only an unscoped caller holds                                           |
| `GET /api/buckets/{name}/analytics`               | 404                                                                                                      |
| `GET \| POST /api/buckets/{name}/rag/enabled`     | 404                                                                                                      |
| `POST /api/buckets/{name}/bulk-delete`            | 404                                                                                                      |
| `GET /api/bulk-delete-jobs/{jobId}`               | the job row names its bucket; check that bucket, 404 otherwise                                           |
| `GET /api/activity`                               | filter the bucket entries to the resolved set                                                            |
| `POST /api/presign`                               | per operation, the bucket in the set and the effective permission for it; one denial refuses the batch   |
| `POST /api/buckets/{name}/query` (bearer)         | the creator's live access, capped by the key's own bucket refs ([§4](#4-access-keys-belong-to-a-member)) |
| `POST /api/access-keys`                           | name, region, expiry; the grant derives from the caller ([§4](#4-access-keys-belong-to-a-member))        |
| `POST /api/org/invitations`                       | carries the invited member's marker and bucket grants ([§7](#7-policy-lifecycle))                        |
| `PATCH /api/org/members/{userId}`                 | role and scope changes; a narrowing re-syncs the member's keys ([§7](#7-policy-lifecycle))               |
| `GET \| PUT \| DELETE /api/buckets/{name}/policy` | read, replace, delete, `buckets.policy_manage`                                                           |

`buckets.policy_manage` is a new permission in
`packages/shared/src/permissions.ts`, held by Owner and Admin. Those are the two
roles `members.manage` already sits at, so nobody gains or loses an ability on
the day it ships. Reading and writing take the same permission: a member who
could read the document would learn every other member named on that bucket and
what each of them can do. What a member sees on the bucket page instead is their
own effective permissions there, which reveals nobody else.

**A bucket with no policy answers `GET .../policy` with its own error code**,
the way S3 answers `NoSuchBucketPolicy`, distinct from the 404 a missing bucket
gives. Only Owner and Admin reach this route and both already know the bucket
exists, so the disclosure argument below does not apply, and the editor opens on
an empty document instead of guessing whether the read failed.

**An out-of-scope bucket answers exactly like a bucket that does not exist.**
Same status, same body, no new `ApiErrorCode`, since a distinct code would
confirm the bucket exists. That costs a worse message for a member whose access
was removed while their tab was open, who gets "Bucket not found" where "your
access was removed" would be truthful. Hiding and explaining are exclusive here,
and hiding is what the feature is.

`POST /api/presign` refuses the whole batch on one denial, per M1's rule. The
batch carries one `region` query parameter covering every operation
(`presign.ts:246`), so the handler resolves the caller's map once and checks
each operation's bucket and verb against it.

A queued bulk-delete job runs to completion, because the job row carries no
creator (`lib/bulk-delete-jobs.ts:90-100`) and the worker drains its queue after
the request returns. Removing somebody from a policy stops them reading the
job's status while their deletion finishes unannounced.

### 4. Access keys belong to a member

A key request carries a name, a region, and an optional expiry, and nothing
else: `permissions`, `granularPermissions`, `buckets`, and `bucketScope` all
leave `CreateAccessKeySchema`. The caller chooses nothing about the grant. The
orchestrator synthesizes it from the caller's effective access in the requested
region, by the same resolution the request path uses
([§3](#3-resolving-access-on-a-request)), and stamps it on the vendor key
([§10](#10-the-service-orchestrator-interface)):

- An **unscoped caller** (Owner, Admin, or a member marked `'all'`) gets a
  tenant-wide key with no bucket list. Its permission set is the inverse of M1's
  requirement maps: every key permission whose console requirement the caller's
  role holds, granulars included (`ACCESS_KEY_PERMISSION_REQUIREMENT` and
  `GRANULAR_ELEVATIONS`, `packages/shared/src/access-key-permissions.ts:27-70`),
  minus `CreateBucket` and `DeleteBucket` (Decision 11).
- A **scoped caller** gets the buckets in that region whose statements allow
  them anything, and a permission set that is the union of what those statements
  grant, intersected with the role's mapped permissions.
- **The role is a ceiling, with one exception.** A scoped member's key carries
  what their statements grant and no more, which keeps
  [§1](#1-what-a-bucket-policy-is)'s rule that a ReadOnly member on a read-write
  bucket still cannot write. The exception is `PutObjectRetention` and
  `PutObjectLegalHold`, where a statement supplies the elevation the role would
  otherwise have to carry ([§1](#1-what-a-bucket-policy-is)).
- A scoped caller whose access in that region is empty is refused with the
  reason named: they hold `keys.create` and there is nothing to point a key at.

**A ReadOnly member cannot mint a key at all**, per M1's matrix, so their
statements govern the console alone.

**The key's permission set is flat because the vendor primitive is flat**: one
permission list over one bucket array (`IssueAccessKeyOpts`,
`lib/service-orchestrator.ts:66-72`). A member with read on one bucket and write
on another gets a key whose set is the union, so that key can write the bucket
their policy allows them only to read. Per-bucket policies make differing verbs
across a member's buckets ordinary, so this fires routinely. It is bounded by
the member's own buckets, the console refuses what the policies refuse, and it
ends where enforcement moves into the storage system: M3's direct-key
enforcement (FIL-1025, on FIL-918) reads a key's authority from the member
exactly. Expressing it sooner means either letting the caller choose a narrower
grant or issuing one credential per permission set, and both cost more than the
union does ([Options considered](#options-considered)).

M1's creation-time cap disappears by construction. `checkCreatorAuthority`
(`handlers/create-access-key.ts:207-222`) refused any requested permission the
creator did not hold in the console; there is no requested set to cap, and the
grant cannot exceed the member because it is computed from the member.

**The key record lives in the store and names the member.** It carries the
attribution M1 already writes (`createdBy`) plus the stamped grant, and it moves
from `UserInfoTable` into the store with the rest of the domain
([§9](#9-rollout), [§10](#10-the-service-orchestrator-interface)). Nothing ties
a key to a policy. Divergence is measured against the member, by comparing the
stamped grant to their live effective access. A key wider than its member is
revoked by [§7](#7-policy-lifecycle)'s re-sync, and by the reconciliation pass
where a race let one through ([§9](#9-rollout)). A key narrower than its member
persists by design, since revoking a too-narrow credential breaks a client to
grant nothing, and the key list marks it so the member knows a new key would
reach further. On a region whose keys derive from the member live, the stamp
means nothing: a key read answers with effective permissions from the storage
system, so the console reads one shape everywhere. A `recovered` record's
attribution names whoever retried, who may not be the creator
(`lib/dynamo-records.ts:54-59`), so the re-sync treats recovered records like
unattributed ones: counted in the dialog, never auto-revoked.

**RAG API keys already work this way.** Their schema carries no permissions at
all (`packages/shared/src/api/rag-api-keys.ts:37-68`), and the bearer branch
resolves the creator's live membership on every query, refusing when it is gone
(`middleware/rag-query-auth.ts:112-178`). A query is checked against the
creator's live effective access on that bucket, capped by the bucket refs the
key was minted with. That cap is what the creator asked for at mint time, and
letting a widening reach a credential nobody re-examined is the surprise worth
avoiding. Because the authority resolves live, a narrowing binds on a RAG key
with no revocation, which makes it the one credential in the product outside
[§7](#7-policy-lifecycle)'s re-sync.

Aurora's keys are immutable and our FTH integration has no key update
([§10](#10-the-service-orchestrator-interface)), so a key cannot change when its
member does. Making keys follow the member on those backends means revoking and
reissuing them, which is [§7](#7-policy-lifecycle)'s re-sync. Forge gets out of
that once FIL-918 lands. Its requirement is a key whose authority derives from
the member at the enforcing system, and a key read that returns effective
permissions from there instead of from our record. The console flow is then one
flow with two regional outcomes, a difference FIL-1024's per-region matrix has
to show.

**Both measured backends enforce the key's bucket list against object
operations.** Aurora and FTH were measured on staging (2026-08-26):

| Region                 | Refuses an out-of-scope object read | Lists only the key's buckets   |
| ---------------------- | ----------------------------------- | ------------------------------ |
| `eu-west-1` (Aurora)   | yes                                 | yes                            |
| `us-east-1` (FTH)      | yes                                 | no, the whole tenant came back |
| `eu-central-3` (Forge) | untested                            | yes                            |

A scoped key reading a bucket it does not name is refused. The synthesized grant
depends on that. Whether Forge also refuses is unmeasured, and being ours an
unwanted answer there is a bug to fix.

**Enumeration lists names it cannot act on.** `aws s3 ls` reaches the storage
gateway directly and never touches a FilOne handler, so the route table above
does nothing for it, and every key FilOne mints carries `s3:ListAllMyBuckets`
unconditionally (`ALWAYS_PERMISSIONS`, `lib/orchestrator/orchestrator.ts:497`;
`FTH_ALWAYS_PERMISSIONS`, `fth-orchestrator.ts:382`; on Aurora the action rides
inside the `Default` grant, `aurora-portal.ts:107`). On FTH a scoped key
therefore lists every bucket in the tenant. The output is names alone: that key
cannot read, write, or delete an object in a bucket it does not name, and the
console shows the member nothing outside their policies. `aws s3 ls` against AWS
itself lists buckets the caller cannot open, so the output means the same thing
in both places.

The Management API contract should still say that a key with a non-empty
`buckets` array lists only those buckets, since `CreateAccessKeyRequest.buckets`
promises today only that the key "may only operate on these buckets" and says
nothing about what the key lists, and that sentence is how a new orchestrator is
bound. Aurora and Forge already behave that way. FTH's change request travels in
the message carrying the lifecycle-feed ask from
[§6](#6-bucket-lifecycle-moves-to-the-console).

FIL-1017 asks for out-of-scope buckets to be "absent from console and from
ListBuckets on that member's keys". The console half is met in full. The
ListBuckets half is met in two of three regions and accepted as outstanding in
the third ([Open questions](#open-questions)).

A key minted before policies existed carries no bucket list, so it enumerates
tenant-wide everywhere. That is the legacy transition (FIL-1020) and the reason
scoping a member should prompt a review of the keys they already hold
(FIL-1021).

### 5. What a scoped member can still see

Decision 9 leaves the aggregates org-wide, so a scoped member can still learn
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
([§4](#4-access-keys-belong-to-a-member)). Neither is closed.

Presigned URLs already issued stay valid until they expire, up to 7 days for
downloads (`handlers/presign.ts:43`), the real revocation bound for object reads
after a policy change.

The activity feed is scoped, because it names individual buckets.
`fetchBucketActivities` calls `orchestrator.listBuckets(tenantId)` in each
provisioned region and renders one `bucket.created` entry per bucket, carrying
the name (`handlers/get-activity.ts:136-166`), which would hand every bucket
name in the org to every role. The handler filters those entries against the
same resolved map `GET /api/buckets` uses. Key entries need no change, since M1
already narrows them by `createdBy` under `keys.manage_own`.

### 6. Bucket lifecycle moves to the console

**A bucket gets its policy immediately after it is created.**
`POST /api/buckets` calls the orchestrator and, on success, writes a policy
holding one `Allow` statement naming the creator with the actions their role
holds, plus the `bucketCreatedAt` the create reported. An Owner, an Admin, or a
member marked `'all'` reaches the bucket regardless of the statement; it is what
a later scope change falls back on.

The write follows the create because a successful create proves no bucket of
that name existed in that region. The row key is the bucket's name and region,
so a write attempted first would land on the live policy of whatever bucket
already holds that name, and the cleanup after a rejected create would then
delete it: anyone holding `buckets.create` could strip a bucket's access control
by attempting to create its name. Two concurrent creates of one name cross the
same way. Writing after the create removes both, and an existing row at that
point belongs to a bucket that is gone, so the write replaces it.

What the post-write leaves is a bucket whose creator cannot see it until the
policy lands. That state is fail-closed, visible to every unscoped caller,
marked in the console ([§9](#9-rollout)), and repaired by the next
reconciliation pass.

**Bucket deletion retires the policy and re-syncs the members it named.** The
row key is the bucket's name and region, so leaving the row behind means a
reclaimed name inherits the old bucket's principals. The re-sync is not
optional: under the flat grant a key over `{A: read, B: write}` carries both
verbs across both buckets, so deleting `B` leaves that key able to write `A`,
which no statement allows. Deleting a bucket is a narrowing like any other and
takes [§7](#7-policy-lifecycle)'s flow.

A deleted name cannot currently be reclaimed on either measured Service
Orchestrator: FTH reports that `us-east-1` reserves the name, and `eu-west-1`
answers HTTP 409, "This bucket name is already taken". Nothing in the Management
API spec requires that behavior, so either vendor could change its name policy
without breaking a promise, and Forge is unmeasured ([Open
questions](#open-questions)).

A Member can create a bucket and cannot edit its policy, since reading and
writing one is `buckets.policy_manage` ([§3](#3-resolving-access-on-a-request)).
Widening it means asking an Owner or Admin, which is how a member gets every
other grant. The creation form says who will be able to see the bucket before it
is created.

**Customer keys stop carrying `CreateBucket` and `DeleteBucket` in every
region.** The `filone-console` key keeps both actions, so the console's own
bucket lifecycle is untouched. A customer credential can no longer create or
delete a bucket unobserved. That is what pairs every bucket with a policy and
keeps a deleted name from carrying its principals to whatever reclaims it.

The two operations reach a different API surface at each Service Orchestrator.
On Aurora both are Portal API calls (`createAuroraBucket` and
`deleteAuroraBucket`, reached through `createPortalClient`), so only FilOne can
make them and the region has never had the exposure. On FTH and Forge they are
S3 data-plane operations: the console performs them with the tenant's
`filone-console` credential, and a user key carrying `s3:CreateBucket` or
`s3:DeleteBucket` performs the identical operation without FilOne seeing it.
Aurora is built this way today, so FTH and Forge would be matching a shipped
region, and every region then behaves the same way. That is one answer to
FIL-1024's question of whether capabilities should differ by region at all.

The change is small and reversible. `BUCKET_PERMISSIONS`
(`packages/shared/src/api/access-keys.ts`) stops being offered, the synthesis
excludes both values, and `supportsBucketManagement`
(`packages/shared/src/constants.ts:94`) is deleted with both its callers: the
schema refine at `access-keys.ts:205` and the console form effect at
`packages/website/src/lib/use-access-key-form.ts:65-70`, neither of which has
anything left to gate. Re-enabling is the same edit backwards, with no migration
either way. A denied attempt answers with the vendor's `AccessDenied`, the S3
error FIL-1019's acceptance criteria ask for.

Customers scripting bucket lifecycle against the S3 API lose that capability.
The product ships it today in the FTH and Forge regions. The Console API is
session-authenticated, so no credential FilOne issues reaches
`POST /api/buckets` either, and scripted bucket lifecycle has no supported path
until an orchestrator reports lifecycle events and the permission can return.

**Keys minted before this ships keep both permissions until FIL-1020 retires
them, and the exposure stays open for that window.** A legacy key can create a
bucket with no policy, which only unscoped callers then see, and delete one
whose policy row outlives it. Two things cover the window: the console labels
both permissions as legacy on the keys that hold them, which gives FIL-1021's
key review something to act on, and the reconciliation pass writes the missing
policy and retires the orphaned row ([§9](#9-rollout)). Until FIL-1020 lands,
the claim that every create and delete passes through a handler holds for keys
minted under this design and not for the ones that predate it.

With console operations mediating lifecycle, `bucket.created` and
`bucket.deleted` become writable. Each carries the acting user, the region, the
bucket name, and the timestamp.

### 7. Policy lifecycle

**Editing a policy re-syncs the keys of every member it names.** A key is a
stamp of its member's access at issue, and no Service Orchestrator except Forge,
after FIL-918, can change one in place. The re-sync is `syncMemberKeys`
([§10](#10-the-service-orchestrator-interface)): a dry run returns the keys a
commit would revoke and fills the dialog; the commit takes `retainKeyIds` and
revokes everything not named. **Revocation is by omission**, so omitting the
field revokes, and the safe outcome does not depend on a checkbox being
pre-checked. Unchecking a key in the dialog adds it to `retainKeyIds`.

The dialog names the buckets and actions at issue, not just a count. Keys minted
before M1 have no owner and never will, and `recovered` records name whoever
retried, so neither can be attributed to a member and neither is ever
auto-revoked. The dialog carries their count beside the named list, so an admin
reads "3 keys will be revoked, 7 keys in this org have no recorded owner and are
not touched" instead of a list that looks complete. Labelling those keys and
restricting them to Owners and Admins is FIL-1020.

A **widening** revokes nothing. The keys stay narrower than the member, marked
on the key list so the member knows a new key would reach further. Revoking one
breaks whatever client holds it and grants the member nothing.

**The policy write commits before the revocations.** A key over-grants from the
moment it is minted until it is revoked, so revoking a few seconds after the
write extends something that already exists. Revoking first and then failing the
conditional write destroys credentials for an edit that never landed, and the
member has no way to tell that from a deliberate revocation. What the
write-first order leaves is a window in which the console is narrower than the
gateway, which is the state every unrevoked key is already in, and a mint that
resolved before the write and recorded after the enumeration. The reconciliation
pass catches both ([§9](#9-rollout)), and `deleteAccessKey` is idempotent
([§10](#10-the-service-orchestrator-interface)), so a re-drive is safe. How fast
a revocation binds at the provider is what FIL-1018 is still asking vendors, and
it has no answer yet.

**Two rules cover which operations do what.** Every write to a policy row emits
an audit event, whatever path produced it ([§8](#8-audit-events)). Every
mutation that can narrow a member's effective access re-syncs their keys: a
policy put, a policy delete, a bucket delete, the removal sweep, a demotion, and
a scope change from `'all'` to `'specific'`. Invite acceptance and promotion
widen only, so neither re-syncs.

**Invite.** An invitation carries the `bucketScope` marker and, when the marker
is `'specific'`, a list of `(region, bucketName, actions)` triples, on the row
M1 already writes at `ORG#{orgId}` / `INVITE#{inviteId}`. Only an Owner or Admin
can set them, since only they can write a policy, and an Owner or Admin
invitation carries neither, both roles being unscoped. Acceptance lands the
membership transaction first, then appends one `Allow` statement per bucket, and
reports the buckets it skipped. An append re-reads and retries on a
conditional-write conflict: an admin editing that bucket and an invitee joining
it are not competing to write the same thing. The invitation row survives
acceptance, so a partial write is re-drivable. The order fails safe, since a
member whose membership landed and whose statements did not sees only what their
marker allows. An invitation grants a bucket; narrowing what the new member can
do there is an ordinary policy edit afterwards.

**Demotion and scope change** run through `PATCH /api/org/members/{userId}`,
which commits the role or marker change and the revocations in one request. The
request may carry `retainKeyIds`; sending none revokes every stranded key, per
the rule above. There is no preview call, because the outcome of demoting an
unscoped member is predictable from the request: their tenant-wide keys go.

**Promotion** leaves every statement in place, inert, since an unscoped role
never reads them. Retention lets a later demotion land on the grants the member
had, and the console renders a promoted member's statements as inactive rather
than hiding them.

**Removing a member** from the org strips their principal from every statement
naming them, `Allow` and `Deny` alike. An orphaned principal grants nothing on
its own, because `authorize()` refuses a caller with no membership row, but it
would revive if that user rejoined the org, and a stale `Deny` would come back
with it. The sweep is `removeMemberFromPolicies`, bounded by buckets per org,
and `deletion-scrub.ts` learns the new table so a missed sweep is still
collected. Member removal revokes keys through FIL-1021's flow rather than this
one's.

**Deleting an org** reaches the new table through `deleteTenant`, which destroys
the policy rows and the key records with the tenant.

### 8. Audit events

M1 shipped the audit write path and closed its event list at
`member.role_changed` and `member.removed`. FIL-1022's first acceptance
criterion asks for membership changes including scope, so this feature adds the
events while FIL-1022's ADR owns the viewer, the retention, and the export.

- `bucket_policy.put` — the bucket, the region, the document that landed, and
  the ids of any keys revoked with it.
- `bucket_policy.deleted` — the document as it stood, plus revoked key ids.
- `bucket.created` — the acting user, region, bucket name, and the policy
  written with it.
- `bucket.deleted` — the acting user, region, bucket name, and revoked key ids.
- `member.scope_changed` — the marker's old and new values, plus revoked key
  ids.

**Every write to a policy row emits one of the first two, whatever path produced
it**: the `PUT` route, invite acceptance, the removal sweep (one event per
document it touches), bucket creation, bucket deletion, and the reconciliation
pass. Without that the replay below has gaps exactly where a member joins or
leaves, which are the periods an auditor asks about.

The put event carries the document that landed. The previous document is the
previous event's payload, so replaying the sequence answers "what could this
person reach in March" without the writer computing a diff nobody may ever read.
There are no statement-level events, because a statement is not separately
addressable: `PUT` replaces the document ([§2](#2-data-model)).

A policy mutation that revokes keys calls a vendor after writing the policy and
before writing the completion, so it takes M1's intent-and-completion pattern;
`commitAudited`'s single transaction cannot span a vendor call. A crash between
the two leaves a visible dangling intent instead of revoked keys with no record.
The pattern applies to every policy mutation uniformly, so the audit log reads
the same whatever region the bucket is in.

Denials are not logged. A scoped member hitting a bucket outside their policies
gets a 404, and one event per 404 turns the audit log into a traffic log.
FIL-1022 scopes itself to control-plane events, and request-level logging is
FIL-949.

### 9. Rollout

1. **The table.** `BucketPolicyTable` in `sst.config.ts` with point-in-time
   recovery, an IAM grant narrowed to the operations the handlers perform, and
   `deletion-scrub.ts` plus the account-deletion teardown wired to it before any
   row exists.
2. **The write path.** `GET | PUT | DELETE /api/buckets/{name}/policy`,
   `buckets.policy_manage` in the registry, and the editor on the bucket detail
   page, behind the `ORGS_BETA` row pattern (`lib/orgs-beta.ts`). Nothing
   enforces yet.
3. **The marker.** Backfill `bucketScope: 'all'` onto every membership row under
   `sst shell` with a dry run and a verify pass, confirm the stamp, then remove
   the absent-means-all fallback in the following PR. This is the sequence M1
   used for the role fallback ([`2026-08-organizations-roles-m1.md`
   §2](./2026-08-organizations-roles-m1.md#2-roles-and-the-permission-registry)).
   Every member is unscoped when it finishes, so nobody's access changes and no
   bucket needs a policy written to preserve it.
4. **Default policies on new buckets.** `POST /api/buckets` writes the creator's
   policy and `DELETE` retires it
   ([§6](#6-bucket-lifecycle-moves-to-the-console)).
5. **Bucket lifecycle.** `CreateBucket` and `DeleteBucket` off customer keys,
   `supportsBucketManagement` and its two callers deleted. This is the one
   customer-visible behavior change, and it does not depend on step 6.
6. **Enforcement.** The resolver, the route filtering, member-derived key
   issuance, the key records moving into the store, and the re-sync dialog.
7. **`BypassGovernanceRetention`** in the statement vocabulary, disabled until
   every region supports it ([§1](#1-what-a-bucket-policy-is)).

Steps 1 through 4 change nothing observable, so they merge independently.

**The reconciliation pass** runs on a schedule from the same PR as step 4. For
each tenant and provisioned region it lists buckets and reads the region's
policy rows, then: writes a default policy onto a bucket that has none, retires
a policy row whose bucket is gone, retires and replaces a row whose
`bucketCreatedAt` no longer matches the bucket now holding that name, and
re-syncs any member whose keys are wider than their access. The pass is
idempotent and safe to repeat, because it is the backstop for four separate
races: the legacy-key window in [§6](#6-bucket-lifecycle-moves-to-the-console),
a create whose policy write failed, a mint that crossed a narrowing in
[§7](#7-policy-lifecycle), and a revocation that failed after its policy write.

The `bucketCreatedAt` comparison tells an original bucket from a recreation that
reused its name. A name and a live listing cannot. It reconciles which bucket a
policy belongs to. It does not reconcile what the policy says, which would need
an identity no orchestrator exposes ([Options considered](#options-considered)).

The console surface is the policy editor on the bucket detail page, the only
place a policy is authored, and a "which buckets is this person on" list on the
member detail page, gated on `buckets.policy_manage` so that reading somebody
else's grants takes the same permission as reading the document they come from.
A member sees their own list on their own page. There is no org-level policy
collection, because a policy has no identity apart from its bucket.

A bucket with no policy is **marked as such for Owners and Admins**, on the
bucket list and the bucket page, stating that only unscoped members reach it and
offering the editor that fixes it. Scoped members do not see the bucket at all
and unscoped members see nothing unusual, so the mark is for the people who can
act on it. The reconciliation pass clears it without anyone acting, so the copy
says what the state is and does not demand a response.

The key creation form keeps the name, the region, and the expiry, and loses its
bucket and permission pickers.

### 10. The Service Orchestrator interface

The interface today is tenant-addressed on every key call:
`issueAccessKey(tenantId, opts)` takes the caller-chosen permission and bucket
lists (`IssueAccessKeyOpts`, `lib/service-orchestrator.ts:66-72`), and nothing
on the interface names a user or a policy. The changeset gives it the
bucket-access domain:

| Type or method                 | Today                                                              | Becomes                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveMemberAccess`          | —                                                                  | **new**: `(tenantId, member)` returns the `BucketAccess` map for this region ([§3](#3-resolving-access-on-a-request)). `member` is `{ userId, role, bucketScope }`, the console-owned facts resolution needs                                                                                                                                                         |
| policy surface                 | —                                                                  | **new**: `getBucketPolicy`, `putBucketPolicy`, `deleteBucketPolicy`, `listPolicies` for one region, and `removeMemberFromPolicies` for the removal sweep. Mutations take the `updatedAt` they are conditioned on and `retainKeyIds`, and return the keys they revoked; `previewPolicyChange` returns the value the mutation must present ([§7](#7-policy-lifecycle)) |
| `issueAccessKey`               | `(tenantId, opts)`                                                 | `(tenantId, member, opts)`: the grant derives from the member inside the call ([§4](#4-access-keys-belong-to-a-member)), and nothing about it is the caller's to choose                                                                                                                                                                                              |
| `listAccessKeys`               | —                                                                  | **new**: `(tenantId, filter)`, the filter naming a member or the whole tenant; returns key records with their effective permissions, the stamp on a `'reissue'` region and the storage system's answer on a `'live'` one                                                                                                                                             |
| `syncMemberKeys`               | —                                                                  | **new**: re-syncs a member's keys after a change to their access; a dry run returns the keys a commit would revoke, the commit takes `retainKeyIds` and returns the keys it revoked ([§7](#7-policy-lifecycle))                                                                                                                                                      |
| `reconcileBuckets`             | —                                                                  | **new**: `(tenantId)` runs the scheduled pass for this region, returning the policies it wrote, the rows it retired, and the keys it revoked ([§9](#9-rollout))                                                                                                                                                                                                      |
| `keyGrantSync`                 | —                                                                  | **new** readonly capability, `'reissue' \| 'live'`: whether an existing key follows its member by revocation and reissue, or automatically at the enforcing system                                                                                                                                                                                                   |
| `IssueAccessKeyOpts`           | `keyName, permissions, granularPermissions?, buckets?, expiresAt?` | `keyName, expiresAt?`                                                                                                                                                                                                                                                                                                                                                |
| `deleteAccessKey`              | idempotent revoke                                                  | unchanged in signature; the implementation deletes the store's key record with the vendor key, still idempotent ([§7](#7-policy-lifecycle))                                                                                                                                                                                                                          |
| `createBucket`, `deleteBucket` | bucket lifecycle                                                   | `createBucket(tenantId, member, args)` writes the new bucket's policy after a successful create and returns it; `deleteBucket` retires the policy and re-syncs the members it named ([§6](#6-bucket-lifecycle-moves-to-the-console))                                                                                                                                 |
| `getS3ClientContext`           | per-tenant `filone-console` key                                    | unchanged: console-side enforcement keeps signing with it ([§3](#3-resolving-access-on-a-request))                                                                                                                                                                                                                                                                   |
| tenant and usage methods       |                                                                    | unchanged in signature; `deleteTenant` now also destroys the store's policy rows and key records ([§7](#7-policy-lifecycle))                                                                                                                                                                                                                                         |

The gap between the vendor model and the product's is written once:
`lib/bucket-access`, the shared store holding `BucketPolicyTable`, the key
records, and the resolution logic ([§2](#2-data-model)). All three
implementations compose it today, and all three answer `'reissue'`. The vendor
underneath differs per implementation:

- **Aurora** has no user object and no key update; the Portal API's key surface
  is create, list, get-by-id, and delete (aurora-portal-client
  `sdk.gen.ts:1002-1063`). The implementation stamps the grant onto the key
  (base plus granular plus `AURORA_ACCESS_ALWAYS`,
  `lib/aurora/aurora-portal.ts:107`), and the member travels no further than the
  key record.
- **FTH**'s client is also create, list, get, and delete
  (`fth-management-client.ts:29-40`), but FTH is the one vendor with a user
  object. Keys already hang off a storage user, today the single shared
  `filone-console` user per tenant (`fth-orchestrator.ts:227-250, 453-467`), and
  the client already provisions users (`createStorageUser`,
  `fth-management-client.ts:25`, args at `:191-198`). Whether the implementation
  maps members onto per-member storage users or keeps the shared one is the
  implementation's own concern, and the mapping is only possible because the
  member is on the call. Per-member users have their own preconditions:
  `CreateStorageUserArgs` requires an email and a display name, and M1 lets only
  a verified address name a credential, so a member without one keeps the shared
  user.
- **Forge** runs on the shared store until FIL-918 lands, then swaps it for
  [Hilt](https://github.com/fil-forge/hilt): policies live at the storage
  system, a key's authority derives from the member live, `keyGrantSync` answers
  `'live'`, and the implementation keeps no rows, so Hilt also answers
  `listAccessKeys`. Attribution, key name, and expiry come back with the
  effective permissions, and only the stamped grant disappears. The re-sync
  dialog stops appearing in that region, since nothing strands, and the flat
  permission set stops rounding up, since the grant is no longer flat. That is
  the genuine per-region difference, M3's work makes it visible, and
  `keyGrantSync` is the fact FIL-1024's per-region matrix reads. `'live'` has no
  implementer until FIL-918, so the console's quiet branch exists from day one
  and first runs in M3.

The console flow branches once, on `keyGrantSync`: `'live'` re-syncs nothing,
`'reissue'` opens [§7](#7-policy-lifecycle)'s dialog. No other console code
branches on the region. That single capability is how the interface admits Forge
is different without becoming three interfaces, and it keeps per-provider
branches out of the console.

The console passes the member across: a `userId`, a role, and the marker. Orgs,
membership, and roles stay console-native per M1, and no implementation reads
the console's org tables. The store belongs to the implementation, the way
`ensureTenantReady`'s setup state machine already does
(`service-orchestrator.ts:170-188`).

Callers change with it. `create-access-key.ts` drops `checkCreatorAuthority`
([§4](#4-access-keys-belong-to-a-member)), `CreateAccessKeySchema` shrinks with
`IssueAccessKeyOpts`, and the bucket-policy routes in
[§3](#3-resolving-access-on-a-request)'s table become thin handlers over the
policy surface. The key records move out of `UserInfoTable` into the store, so
`list-access-keys.ts` calls `listAccessKeys` on each provisioned orchestrator
and merges, the way `list-buckets.ts` does, and the `keys.manage_own` narrowing
keeps working over the merged records. `test/fake-orchestrator.ts` is untyped
against the interface and stubs none of the key methods, so it gains stubs for
the methods its tests exercise.

## Options considered

**A policy over a set of buckets, with a roster of members**, is one rule an
admin edits once while every member on it moves together. Twelve members sharing
eight buckets are one document instead of eight. It cannot be attached to a
bucket, which costs the S3 route shape and the identity: a policy needs its own
id, its own org-level collection, and its own page, and "which policies name
this bucket" becomes a query and a filter instead of a read. Overlapping
policies then have to compose, which means a union rule, a member's permission
on a bucket assembled from several documents, and an admin who narrows one
document without narrowing the member. One policy per bucket makes the bucket
page the whole story and the narrowing exact. The cost is authoring effort:
granting a team eight buckets is eight edits, with no group abstraction in M2 to
collapse them.

**A key minted from one policy**, taking all or part of its permissions and
buckets and recording the version it was issued under, gives every key a
nameable source and a grant that matches the statements exactly. It derives the
credential from the rule instead of the person, so a member whose access spans
buckets holds several credentials where an AWS customer expects one, and minting
requires a picker no S3 console has. It also does not survive a role change: a
demoted member's policy-minted keys are exactly as wrong as anyone else's, so
member-level re-sync is needed anyway, and once it exists the policy tie adds a
second divergence axis without adding control.

**Letting the caller narrow the key** is AWS's session policy, the `--policy` on
`AssumeRole`: the request names a subset of the member's buckets, and the
permission set is the intersection across the ones they named, never wider than
the member. It gives a member exactly what their statements say
([§4](#4-access-keys-belong-to-a-member)), and a member wanting write on one
bucket gets a key that writes it. It also puts a choice back on the credential,
so the key answers to something other than its holder, and the console has to
explain why picking a second bucket removes a checkbox. The union is bounded and
it ends at M3. The choice would not.

**One key per distinct permission set** keeps the caller out of it and still
matches the statements: a member with read on three buckets and write on two
gets two credentials, each flat over the buckets that agree. It answers one key
request with several credentials, which no S3 client expects, and it makes the
number of credentials a person holds a function of how their admin wrote
unrelated policies.

**Caller-chosen key permissions**, the shipped model, lets a customer mint a
deliberately narrow key, a read-only credential for one app. It attaches
permissions to credentials instead of people: the console matrix is advisory
until a creation-time cap patches it (M1's `checkCreatorAuthority`), and nothing
can say what a key should become when its holder's access changes. The
narrow-key use case is better served by a principal whose access is itself
narrow ([Open questions](#open-questions)).

**Resolving scope from the policy store alone**, with no marker on the
membership row, leaves "no statement names me" ambiguous between a member nobody
has scoped yet and a member scoped to nothing. Resolving it costs a Query on the
request path to learn that most callers are unscoped, and it removes the only
way to say "this member sees every bucket, including the ones that do not exist
yet", since a statement needs a bucket to live on and a bucket created tomorrow
has no statement naming anybody. FIL-1017 asks for exactly that grant at invite
time. The marker costs a denormalized field that can drift from the policies and
a backfill to seed it.

**Writing an `Allow *` statement onto every bucket that exists today**, instead
of stamping the marker, would express current access in the policies themselves
and leave one mechanism rather than two. It fans out over every tenant and
region to write rows that say what the marker says in one attribute, and it
splits buckets into two populations forever: those that carry the statement, and
those created afterwards, which name their creator. The marker leaves one
population and no sweep.

**A grant per member and bucket**, one row keyed `(member, bucket)`, gives the
request path an O(1) `GetItem` and needs no evaluation. It gives an admin no
rule to edit and no document to read: twelve members on eight buckets are
ninety-six rows with no shape, and nothing records that the twelve belong
together. It is also the read-path shape a per-bucket policy already provides,
without the document.

**Materializing policies into per-member rows** keeps both, policies as the
authoring layer expanded into `(member, bucket)` rows. The write amplification
rules it out, and every projection write is a chance to drift from the documents
that are the source of truth. The projection can disagree with the policies it
came from, and nothing on the request path would notice.

**A bucket with no policy reachable by every member**, scoped ones included,
would need no marker and no default policy. It also makes
`DELETE /api/buckets/{name}/policy` a route that silently opens a bucket to the
whole org, so one click would widen access while appearing to remove it.

**Intersection instead of union** across a member's statements would let an
admin narrow somebody by adding a restrictive statement. `Deny` is the AWS
spelling of that and it is in the design; making the default composition
subtractive is not, because adding a member to an Allow statement would then
silently remove a permission they already had.

**Withholding `s3:ListAllMyBuckets` from a scoped member's keys** refuses
enumeration whatever the gateway does. It costs the command outright, since
`aws s3 ls` then answers `AccessDenied` and breaks tooling that enumerates
before it acts, and on Aurora the action rides inside the `Default` grant, so
withholding it drops `s3:GetBucketLocation` with it and `ListBuckets` is
answered anyway.

**Reconciling what a policy says against the vendor**, so that customer keys
could keep bucket lifecycle and the rows repaired themselves, needs to know
whether the bucket now holding a name is the one the policy was written for and
what happened in between. [§9](#9-rollout)'s pass answers the first half from
`bucketCreatedAt`, so it can retire a policy whose bucket was replaced. It
cannot answer the second: no orchestrator reports who acted or what a bucket's
permissions were, so a reconciler cannot rebuild a policy's contents or
attribute a change, and `bucket.created` and `bucket.deleted` would carry no
actor. That is why lifecycle moves to the console
([§6](#6-bucket-lifecycle-moves-to-the-console)) and the pass stays a backstop.

**Policies as console data above the interface**, with the orchestrator taking a
pre-resolved grant on each key call, keeps the M2 interface a few lines long and
gives every policy mutation `commitAudited`'s one-transaction guarantee
directly. It leaves the vendor gap in the console permanently. The policy store
exists only to imitate what a real IAM backend does natively, and holding it
above the interface means M3 must push the console's policy state into the
system enforcing it, a sync channel that can drift, while the enforcing system
never owns the rules it enforces.

## Open questions

1. **Does console-mediated enforcement end on Aurora and FTH?** The
   `filone-console` credential addresses every bucket in the tenant. M3 is
   direct-key enforcement on Forge (FIL-1025, on FIL-918), which leaves the
   other regions where [§3](#3-resolving-access-on-a-request) puts them unless a
   vendor answers. Whether they ever reach parity is the "parity vs Forge-first"
   decision the M3 milestone is gated on.
2. **What Forge does with an out-of-scope object read, and whether it reserves a
   deleted name.** Forge already filters enumeration, so those two columns are
   the ones left to run. Being ours, an unwanted answer there is a bug to fix,
   which makes it the cheapest of the three to settle.
3. **Whether FIL-1017's ListBuckets criterion stands as written.** Aurora and
   Forge deliver it and FTH does not. Since the output is names a member cannot
   act on, the criterion is met in substance and unmet in letter on one region.
   The ticket owner decides whether to relax it or to hold the release to FTH's
   change request, and this design ships either way.
4. **What returns bucket lifecycle to customer keys.** A feed carrying bucket
   creations and deletions, with the acting access key identified, on the two
   Service Orchestrators that need one. On Forge that is the same Hilt work the
   rest of M3 needs; on FTH it is a vendor ask. Aurora needs nothing, having
   never had the exposure. The same message closes the `ListBuckets` question in
   [§4](#4-access-keys-belong-to-a-member), so both asks should travel together.
5. **Whether a statement should carry a prefix.** The resource is implicit today
   and a prefix is the field that makes it explicit. Prefix scope is Tier 3 work
   and belongs to the Forge enforcement story, and nothing here blocks it. Which
   ticket owns it is unsettled.
6. **How many buckets an org holds before the per-region Query stops being
   cheap.** [§3](#3-resolving-access-on-a-request) reads a region's policies on
   every bucket listing by a scoped member. That number decides whether a
   per-member inverse row is ever worth its consistency risk.
7. **How often the reconciliation pass should run.** The window it leaves is a
   bucket only unscoped callers can see, and the console marks it,, so the
   cadence is a product choice about how long that mark may stand.
8. **Where a deliberately narrow service credential comes from.** A key carries
   its member's access, so a customer wanting a read-only credential for one
   application has no way to mint one. Service accounts are outside the PRD's
   scope, and a principal whose own access is narrow is the shape that would
   answer it.

## References

- Tickets: FIL-1017 member bucket scope, FIL-1018 revocation timing at vendors,
  FIL-1019 privileged operations (the bucket-lifecycle half is decided here),
  FIL-1020 legacy key transition, FIL-1021 key review on scope change, FIL-1022
  audit viewer, FIL-1024 per-region disclosure, FIL-1025 M3 direct-key
  enforcement, FIL-918 Forge key update, FIL-949 request-level logging.
- [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md) for
  roles, the permission registry, the audit write path, and the backfill
  sequence this design follows.
- [`2026-08-privileged-operations-m2.md`](./2026-08-privileged-operations-m2.md)
  for the governance-retention bypass, whose capability
  [§1](#1-what-a-bucket-policy-is) carries as a statement action.
- Staging measurement, 2026-08-26: `ListBuckets` conformance per region
  ([§4](#4-access-keys-belong-to-a-member)).
- The tier split source is missing. Four M2 tickets cite a "2026-08-11
  enforcement analysis", which the M1 ADR names
  `iam-prd-enforceability-by-backend.md` in the knowledge-base repo. That repo
  holds 61 files at HEAD and none of them is it. The Tier 2 and Tier 3
  vocabulary it defines sorts work across FIL-1017 through FIL-1024. This design
  does not depend on it: [§4](#4-access-keys-belong-to-a-member) and
  [§6](#6-bucket-lifecycle-moves-to-the-console) measured the backend behavior
  the tier split was there to decide.
