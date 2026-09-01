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
`GetBucketPolicy`, `PutBucketPolicy`, `DeleteBucketPolicy`. The resemblance is
deliberate and it has limits. A policy here names principals inside the org
only, carries no conditions, and cannot be read back from the storage provider,
because no Service Orchestrator accepts a policy document. The rule is enforced
in two places FilOne controls: the console API on every request, and the grant
stamped onto an access key when the key is issued.

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
(FIL-1025, on FIL-918). Under one policy per bucket, buckets carrying different
permissions are the ordinary case rather than the exception, so this is a
routine cost rather than a corner.

**FilOne stores no bucket records.** A bucket exists at the orchestrator and
nowhere else: `list-buckets.ts` fans out across provisioned regions and
concatenates what answers (`list-buckets.ts:60-64`), and `get-bucket.ts` calls
one orchestrator. A bucket does have a stable identity, `(region, bucketName)`.
Every bucket-addressed route carries a region, `BucketSummary` carries one
(`lib/service-orchestrator.ts:36-41`), and the RAG tables already key on
`BUCKET#{orgId}#{region}#{bucketName}` (`lib/dynamo-records.ts`). The region is
part of the identity rather than decoration: nothing prevents the same tenant
from holding `logs` in two regions. `create-bucket.ts:57-62` resolves one
orchestrator for the requested region and creates there, and uniqueness is
enforced by that provider inside that region alone
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
object. The gap between the two models is an approximation somebody has to
write, and where it lives decides what M3 costs. Held above the Service
Orchestrator interface, moving enforcement into Forge means pushing the
console's policy state into the system enforcing it, a sync channel that can
drift. Held behind the interface, Forge swaps the approximation for
[Hilt](https://github.com/fil-forge/hilt) and stores no rows
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
3. **Owner and Admin are unscoped by role**, settled with no read of the policy
   store. Deny does not reach them ([§3](#3-resolving-access-on-a-request)).
4. **A bucket with no policy is reachable by no member.** Every bucket gets one:
   the backfill writes a permissive policy onto every bucket that exists today,
   and `POST /api/buckets` writes one naming the creator
   ([§6](#6-bucket-lifecycle-moves-to-the-console), [§9](#9-rollout)).
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
8. **Org-wide aggregates stay org-wide.** Usage, billing, and dashboard counts
   are not scoped ([§5](#5-what-a-scoped-member-can-still-see)).
9. **Enumeration over S3 is a name listing rather than an access boundary.** The
   key's `buckets` array governs what the key can operate on, which both
   measured backends enforce. Whether a gateway also filters `ListBuckets` is a
   contract item nothing here depends on
   ([§4](#4-access-keys-belong-to-a-member)).
10. **`CreateBucket` and `DeleteBucket` come off customer access keys**, in
    every region, until an orchestrator can report a bucket's lifecycle and the
    key that changed it (FIL-1019). Every bucket's creation and deletion then
    runs through a FilOne handler, which is where its policy is written and
    deleted ([§6](#6-bucket-lifecycle-moves-to-the-console)).

### 1. What a bucket policy is

A bucket policy holds a list of **statements**. Each statement carries an
`effect` of `Allow` or `Deny`, a set of `principals` (member ids, or `*` for
every member of the org), and a set of `actions`. The resource is the bucket the
policy belongs to and is not written down; it is the field that will carry a
prefix when prefix scope arrives (FIL-1018).

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

**Deny does not apply to an Owner or an Admin.** Both are unscoped by role and
the policy store is never read for them. Enforcing a Deny against an Admin would
protect nothing, since `buckets.policy_manage` is the permission that deletes
the Deny and both roles hold it. The policy editor says so where a Deny is
written.

**A ReadOnly member stays read-only whatever a statement allows.** The role
holds `objects.read` and nothing that mutates, so the intersection leaves read
and list however wide the statement is. A policy is also the only route they
have to a bucket, since ReadOnly is denied `keys.create` and cannot mint a key.

A statement's action vocabulary is thirteen of the fifteen values on an access
key, plus one. The thirteen are `read`, `write`, `list`, `delete`,
`GetBucketVersioning`, `GetBucketObjectLockConfiguration`, and the seven
granular data-protection permissions
(`packages/shared/src/api/access-keys.ts`). `CreateBucket` and `DeleteBucket`
are absent: Decision 10 takes both off customer keys, and neither acts on a
bucket a policy could name, since a key holding `CreateBucket` creates buckets
outside it. Bucket creation stays where the M1 matrix puts it, as the org-level
`buckets.create`.

The fourteenth is **`BypassGovernanceRetention`**, the action that overrides a
governance-mode retention lock. It is the S3 spelling of the capability
[`2026-08-privileged-operations-m2.md`](./2026-08-privileged-operations-m2.md)
scopes to a member, and a bucket policy statement is where AWS puts it, next to
`DeleteObject`. Naming it in a statement scopes it to one bucket and one set of
members rather than to the whole org. No Service Orchestrator accepts the bypass
yet, so the action is disabled in the editor and cannot be granted until every
region supports it. The two mutating granulars, `PutObjectRetention` and
`PutObjectLegalHold`, keep M1's rule unchanged: they enter a grant only for an
Owner, whose role holds `privileged.grant`, whatever a statement lists.

A member's reach spans regions because they are named in policies on buckets in
several. Each policy stays inside one region, since its bucket does.

### 2. Data model

Policies live in a new `BucketPolicyTable`, declared in `sst.config.ts` beside
the existing tables, `pk`/`sk` with no secondary index.

| Table               | pk            | sk                             | Attributes                                                                | Purpose        |
| ------------------- | ------------- | ------------------------------ | ------------------------------------------------------------------------- | -------------- |
| `BucketPolicyTable` | `ORG#{orgId}` | `POLICY#{region}#{bucketName}` | `statements`, `updatedAt`, `updatedBy`, `createdBy/At`                    | the policy     |
| `BucketPolicyTable` | `ORG#{orgId}` | `KEY#{region}#{keyId}`         | the stamped grant, `userId`, `createdBy`, `keyName`, `expiresAt`          | the key record |

S3 bucket names contain no `#`, so the sort key composes unambiguously and a
`begins_with` on `POLICY#` returns the org's policies in one Query. Two row
families, no inverse items, and no marker on the membership row.

**Statements ride on the policy row as a list**, so a policy is one item and a
write is one conditional update. The list is bounded by the members named on one
bucket, and a `*` principal collapses the common case to one entry. AWS caps a
bucket policy at 20KB against DynamoDB's 400KB item, so the ceiling is not a
constraint anybody meets.

**`updatedAt` is the write condition.** `PUT` replaces the whole document, the
way `PutBucketPolicy` does, and conditions the write on the `updatedAt` the
caller read. Two admins editing the same bucket conflict instead of one losing
their edit silently. `previewPolicyChange` returns the value it read and the
mutation takes it as its condition, so a stale preview fails rather than
committing against a document that moved ([§7](#7-policy-lifecycle)).

**Reads on the request path carry `ConsistentRead`**, for the reason
`org-membership.ts` gives for the role read: an access-control read must not see
a stale replica. Removing somebody from a policy has to bind on their next
request.

**The store is the approximation, written once.** `BucketPolicyTable`, the key
records, and the resolution logic are `lib/bucket-access`, a shared module all
three orchestrator implementations compose today
([§10](#10-the-service-orchestrator-interface)). Key records move out of
`UserInfoTable` into it, which is what lets a key read answer with effective
permissions from the enforcing system on a region that has one. At M3, Forge
swaps the module for Hilt and stores no rows.

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

Owner and Admin resolve to `{ sees: 'all' }` from the role alone, with no read.
Everyone else resolves against the policies, and a member named in none reaches
no bucket, which is both the fail-closed answer and the AWS one: an identity
with no grant has no access.

A member listing buckets costs one Query on `ORG#{orgId}` with `begins_with`
`POLICY#`, evaluated in memory against the fan-out the handler already performs
for the names. A member addressing one bucket costs one `GetItem` on
`POLICY#{region}#{bucketName}`, which is the common case and O(1). The list
route's cost grows with buckets per org, and the map answers both questions a
route asks: is this bucket in reach, and with which permissions.

The check runs in the handler rather than in middleware, because `authorize()`
decides from the route manifest alone and the manifest cannot name a bucket,
while the bucket arrives in a path parameter or, for `POST /api/presign`, in
each element of the body. This is the `in-handler` requirement M1 already
defines for presign.

| Route                                             | Scoped behavior                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/buckets`                                | filter the merged fan-out result to the resolved set                                                     |
| `POST /api/buckets`                               | allowed; the handler writes the new bucket's policy ([§6](#6-bucket-lifecycle-moves-to-the-console))      |
| `GET /api/buckets/{name}`                         | absent from the set gives the same 404 a missing bucket gives                                            |
| `DELETE /api/buckets/{name}`                      | gated on `buckets.delete`, which only an unscoped caller holds                                           |
| `GET /api/buckets/{name}/analytics`               | 404                                                                                                       |
| `GET \| POST /api/buckets/{name}/rag/enabled`     | 404                                                                                                       |
| `POST /api/buckets/{name}/bulk-delete`            | 404                                                                                                       |
| `GET /api/bulk-delete-jobs/{jobId}`               | the job row names its bucket; check that bucket, 404 otherwise                                           |
| `GET /api/activity`                               | filter the bucket entries to the resolved set                                                            |
| `POST /api/presign`                               | per operation, the bucket in the set and the effective permission for it; one denial refuses the batch    |
| `POST /api/buckets/{name}/query` (bearer)         | the creator's live access, capped by the key's own bucket refs ([§4](#4-access-keys-belong-to-a-member))  |
| `POST /api/access-keys`                           | name, region, expiry; the grant derives from the caller ([§4](#4-access-keys-belong-to-a-member))         |
| `POST /api/org/invitations`                       | carries the invited member's bucket grants ([§7](#7-policy-lifecycle))                                   |
| `PATCH /api/org/members/{userId}`                 | role changes; a demotion re-syncs the member's keys ([§7](#7-policy-lifecycle))                          |
| `GET \| PUT \| DELETE /api/buckets/{name}/policy` | read, replace, delete, `buckets.policy_manage`                                                           |

`buckets.policy_manage` is a new permission in
`packages/shared/src/permissions.ts`, held by Owner and Admin. Those are the two
roles `members.manage` already sits at, so nobody gains or loses an ability on
the day it ships. Reading and writing take the same permission: a member who
could read the document would learn every other member named on that bucket and
what each of them can do. What a member sees on the bucket page instead is their
own effective permissions there, which reveals nobody else.

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

- An **unscoped caller** (Owner or Admin) gets a tenant-wide key with no bucket
  list. Its permission set is the inverse of M1's requirement maps: every key
  permission whose console requirement the caller's role holds, granulars
  included (`ACCESS_KEY_PERMISSION_REQUIREMENT` and `GRANULAR_ELEVATIONS`,
  `packages/shared/src/access-key-permissions.ts:27-70`), minus `CreateBucket`
  and `DeleteBucket` (Decision 10).
- A **scoped caller** gets the buckets in that region whose policies allow them
  anything, and a permission set that is the union of what those policies grant,
  intersected with the role's mapped permissions.
- **The role is a ceiling.** A scoped member's key carries what their policies
  grant and no more, which keeps [§1](#1-what-a-bucket-policy-is)'s rule that a
  ReadOnly member on a read-write bucket still cannot write.
- A scoped caller whose access in that region is empty is refused, naming the
  reason rather than answering a permission error: they hold `keys.create` and
  there is nothing to point a key at.
- The two mutating granulars enter a grant only for an Owner, whose role holds
  `privileged.grant`, until FIL-1019 replaces the blanket elevation with
  per-operation grants.

**A ReadOnly member cannot mint a key at all**, per M1's matrix, so their
statements govern the console alone.

**The key's permission set is flat because the vendor primitive is flat**: one
permission list over one bucket array (`IssueAccessKeyOpts`,
`lib/service-orchestrator.ts:66-72`). A member with read on one bucket and write
on another gets a key whose set is the union, so that key can write the bucket
their policy allows them only to read. Per-bucket policies make differing verbs
across a member's buckets ordinary, so this fires routinely rather than rarely.
It is bounded by the member's own buckets, the console refuses what the policies
refuse, and it ends where enforcement moves into the storage system: M3's
direct-key enforcement (FIL-1025, on FIL-918) reads a key's authority from the
member exactly. Expressing it sooner means either letting the caller choose a
narrower grant or issuing one credential per permission set, and both cost more
than the over-grant does ([Options considered](#options-considered)).

M1's creation-time cap disappears by construction. `checkCreatorAuthority`
(`handlers/create-access-key.ts:207-222`) refused any requested permission the
creator did not hold in the console; there is no requested set to cap, and the
grant cannot exceed the member because it is computed from the member.

**The key record lives in the store and names the member.** It carries the
attribution M1 already writes (`createdBy`) plus the stamped grant, and it moves
from `UserInfoTable` into the store with the rest of the domain
([§9](#9-rollout), [§10](#10-the-service-orchestrator-interface)). Nothing ties
a key to a policy. Divergence is measured against the member, by comparing the
stamped grant to their live effective access. A key wider than its member never
persists, because [§7](#7-policy-lifecycle)'s re-sync revokes it. A key narrower
than its member persists by design, since revoking a too-narrow credential
breaks a client to grant nothing, and the key list marks it so the member knows
a new key would reach further. On a region whose keys derive from the member
live, the stamp means nothing: a key read answers with effective permissions
from the storage system, so the console reads one shape everywhere. A
`recovered` record's attribution names the caller who retried rather than a
confirmed creator (`lib/dynamo-records.ts:54-59`), so the re-sync treats
recovered records like unattributed ones: counted in the dialog, never
auto-revoked.

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

A scoped key reading a bucket it does not name is refused, which is the property
the synthesized grant depends on. Whether Forge also refuses is unmeasured, and
being ours an unwanted answer there is a bug to fix.

**Enumeration is a name listing rather than an access boundary.** `aws s3 ls`
reaches the storage gateway directly and never touches a FilOne handler, so the
route table above does nothing for it, and every key FilOne mints carries
`s3:ListAllMyBuckets` unconditionally (`ALWAYS_PERMISSIONS`,
`orchestrator/orchestrator.ts:497`; `FTH_ALWAYS_PERMISSIONS`,
`fth-orchestrator.ts:382`; on Aurora the action rides inside the `Default`
grant, `aurora-portal.ts:107`). On FTH a scoped key therefore lists every bucket
in the tenant. The output is names alone: that key cannot read, write, or delete
an object in a bucket it does not name, and the console shows the member nothing
outside their policies. `aws s3 ls` against AWS itself lists buckets the caller
cannot open, so a name in that output has never meant access.

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
([§4](#4-access-keys-belong-to-a-member)). Neither is closed.

Presigned URLs already issued stay valid until they expire, up to 7 days for
downloads (`handlers/presign.ts:40`), which is the real revocation bound for
object reads after a policy change.

The activity feed is scoped, because it names individual buckets.
`fetchBucketActivities` calls `orchestrator.listBuckets(tenantId)` in each
provisioned region and renders one `bucket.created` entry per bucket, carrying
the name (`handlers/get-activity.ts:136-166`), which would hand every bucket
name in the org to every role. The handler filters those entries against the
same resolved map `GET /api/buckets` uses. Key entries need no change, since M1
already narrows them by `createdBy` under `keys.manage_own`.

### 6. Bucket lifecycle moves to the console

**A bucket gets its policy in the same request that creates it.**
`POST /api/buckets` writes a policy holding one `Allow` statement naming the
creator, with the actions their role holds. An Owner or Admin creating a bucket
is unscoped by role and reaches it regardless; the statement is what a later
demotion falls back on.

The policy write happens **before** the orchestrator call and is undone if
creation fails. A policy naming a bucket that does not exist grants nothing, so
the pre-write is safe in a way the post-write is not: a write that fails after a
successful create leaves a member unable to see the bucket they just made. The
two steps cannot be one transaction, because the bucket lives at the vendor, so
what survives a failure is a policy row for a bucket that does not exist, inert
until a bucket of that name exists in that region. A creation that fails because
the name is already taken deletes its pre-write before returning, so the
requester never resolves access against a bucket that was somebody else's.

**Bucket deletion deletes the policy.** The row key is the bucket's name and
region, so leaving it behind means a reclaimed name inherits the old bucket's
principals. A deleted name cannot currently be reclaimed on either measured
Service Orchestrator: FTH reports that `us-east-1` reserves the name, and
`eu-west-1` answers HTTP 409, "This bucket name is already taken". Nothing in
the Management API spec requires that behavior, so either vendor could change
its name policy without breaking a promise, and Forge is unmeasured ([Open
questions](#open-questions)). The delete sits outside the vendor call's
atomicity, and it runs silently: the keys naming a deleted bucket reach nothing,
so there is nothing to revoke and nobody to ask.

A Member can create a bucket and cannot edit its policy, since reading and
writing one is `buckets.policy_manage` ([§3](#3-resolving-access-on-a-request)).
Widening it means asking an Owner or Admin, which is how a member gets every
other grant. The creation form says who will be able to see the bucket before it
is created.

**Customer keys stop carrying `CreateBucket` and `DeleteBucket` in every
region.** The `filone-console` key keeps both actions, so the console's own
bucket lifecycle is untouched. A customer credential can no longer create or
delete a bucket unobserved, which is what keeps every bucket paired with a
policy: a bucket created outside a FilOne handler has no policy row, and after
enforcement no member can see it.

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
(`packages/shared/src/api/access-keys.ts`) stops being offered,
`CreateAccessKeySchema` refuses the two values, and `supportsBucketManagement`
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
Keys already carrying the two permissions keep them until FIL-1020 retires them.
The console labels the two as legacy on the keys that hold them, which gives
FIL-1021's key review something to act on.

With every create and delete passing through a handler, `bucket.created` and
`bucket.deleted` become writable for the first time. Each carries the acting
user, the region, the bucket name, and the timestamp.

### 7. Policy lifecycle

**Editing a policy re-syncs the keys of every member it names.** A key is a
stamp of its member's access at issue, and no Service Orchestrator except Forge,
after FIL-918, can change one in place. The re-sync is `syncMemberKeys`
([§10](#10-the-service-orchestrator-interface)): a dry run returns the keys a
commit would revoke and fills the dialog; the commit takes `retainKeyIds` and
revokes everything not named. **Revocation is by omission**, so a client that
sends no field revokes rather than retains, and the safe outcome does not depend
on a checkbox being pre-checked. Unchecking a key in the dialog adds it to
`retainKeyIds`.

The dialog names the buckets and actions at issue, not just a count. Keys minted
before M1 have no owner and never will, and `recovered` records name a retrying
caller rather than a confirmed creator, so neither can be attributed to a member
and neither is ever auto-revoked. The dialog carries their count beside the
named list, so an admin reads "3 keys will be revoked, 7 keys in this org have
no recorded owner and are not touched" instead of a list that looks complete.
Labelling those keys and restricting them to Owners and Admins is FIL-1020.

A **widening** revokes nothing. The keys stay narrower than the member, marked
on the key list so the member knows a new key would reach further. Revoking a
too-narrow credential breaks a client to grant nothing.

When keys are revoked, revoke at the vendor first and write the policy second.
Revocation is a vendor call, so the two steps cannot be one transaction, and
that order keeps a partial failure safe: a failed revoke leaves the policy and
the keys where the operation started, while writing the policy first would
narrow the console while a key still reaches the dropped bucket at the gateway.
Re-driving is safe because `deleteAccessKey` is idempotent
([§10](#10-the-service-orchestrator-interface)). How fast a revocation binds at
the provider is what FIL-1018 is still asking vendors, and it has no answer yet.

**Invite.** An invitation carries `(region, bucketName, actions)` triples on the
row M1 already writes at `ORG#{orgId}` / `INVITE#{inviteId}`. Only an Owner or
Admin can set them, since only they can write a policy, and an Owner or Admin
invitation carries none. Acceptance lands the membership transaction first, then
appends one `Allow` statement per bucket, and reports the buckets it skipped. An
append re-reads and retries on a conditional-write conflict rather than failing:
an admin editing that bucket and an invitee joining it are not competing to
write the same thing. The invitation row survives acceptance, so a partial write
is re-drivable. The order fails safe, since a member whose membership landed and
whose statements did not reaches only the buckets whose policies name `*`. An
invitation grants a bucket rather than a final permission set; narrowing what
the new member can do there is an ordinary policy edit afterwards.

**Demotion** out of an unscoped role re-syncs the demoted member's keys, because
the keys they minted while unscoped are tenant-wide and their access is now
whatever statements name them. The `PATCH /api/org/members/{userId}` response
carries the dry run, so the admin sees what revoking costs before committing.

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
- `bucket.deleted` — the acting user, region, and bucket name.

The put event carries the document that landed rather than a diff. The previous
document is the previous event's payload, so replaying the sequence answers
"what could this person reach in March" without the writer computing a diff
nobody may ever read. There are no statement-level events, because a statement
is not separately addressable: `PUT` replaces the document
([§2](#2-data-model)).

A policy mutation that revokes keys calls a vendor before writing anything
local, so it takes M1's intent-and-completion pattern rather than
`commitAudited`'s single transaction, and a crash between the two leaves a
visible dangling intent instead of revoked keys with no record. The pattern
applies to every policy mutation uniformly rather than per backend, so the audit
log reads the same whatever region the bucket is in.

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
3. **Default policies and the backfill, in one PR.** `POST /api/buckets` writes
   the creator's policy and `DELETE` removes it, and a migration under
   `sst shell`, with a dry run and a verify pass, fans out `ListBuckets` per
   tenant per region and writes an `Allow *` policy onto every bucket that has
   none. Shipping the default before the backfill would leave buckets created in
   the gap reachable by their creator alone while their neighbours stay open,
   which is the discontinuity below arriving early and unexplained.
4. **Bucket lifecycle.** `CreateBucket` and `DeleteBucket` off customer keys,
   `supportsBucketManagement` and its two callers deleted
   ([§6](#6-bucket-lifecycle-moves-to-the-console)). This is the one
   customer-visible behavior change, and it has to precede or accompany step 5,
   because a bucket created with a customer key has no policy and no member can
   see it once enforcement is on.
5. **Enforcement.** The resolver, the route filtering, member-derived key
   issuance, the key records moving into the store, and the re-sync dialog.
6. **`BypassGovernanceRetention`** in the statement vocabulary, disabled until
   every region supports it ([§1](#1-what-a-bucket-policy-is)).

Steps 1 through 3 change nothing observable, so they merge independently.

Two populations of buckets result, and they diverge permanently. A bucket that
existed before step 3 carries `Allow *` and every member reaches it. A bucket
created afterwards names its creator alone. The backfill is what keeps existing
orgs working on deploy day, and the new default is the one an access-control
feature should have. Neither is a special state: `Allow *` is an ordinary
statement an admin can edit or delete, and the bucket page shows the current
principal list, so an admin reading an old bucket sees `*` written down rather
than inferring it from silence. Whether the two are ever reconciled is an open
question.

The console surface is the policy editor on the bucket detail page, the only
place a policy is authored, and a read-only "which buckets is this person on"
list on the member detail page. There is no org-level policy collection, because
a policy has no identity apart from its bucket. The key creation form keeps the
name, the region, and the expiry, and loses its bucket and permission pickers.

### 10. The Service Orchestrator interface

The interface today is tenant-addressed on every key call:
`issueAccessKey(tenantId, opts)` takes the caller-chosen permission and bucket
lists (`IssueAccessKeyOpts`, `lib/service-orchestrator.ts:66-72`), and nothing
on the interface names a user or a policy. The changeset gives it the
bucket-access domain:

| Type or method                 | Today                                                              | Becomes                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveMemberAccess`          | —                                                                  | **new**: `(tenantId, member)` returns the `BucketAccess` map for this region ([§3](#3-resolving-access-on-a-request)). `member` is `{ userId, role }`, the console-owned facts resolution needs                                                                                                                                              |
| policy surface                 | —                                                                  | **new**: `getBucketPolicy`, `putBucketPolicy`, `deleteBucketPolicy`, `listPolicies` for the org, and `removeMemberFromPolicies` for the removal sweep. Mutations take the `updatedAt` they are conditioned on and `retainKeyIds`, and return the keys they revoked; `previewPolicyChange` returns the value the mutation must present ([§7](#7-policy-lifecycle)) |
| `issueAccessKey`               | `(tenantId, opts)`                                                 | `(tenantId, member, opts)`: the grant derives from the member inside the call ([§4](#4-access-keys-belong-to-a-member)), and nothing about it is the caller's to choose                                                                                                                                                                     |
| `listAccessKeys`               | —                                                                  | **new**: `(tenantId, filter)`, the filter naming a member or the whole tenant; returns key records with their effective permissions, the stamp on a `'reissue'` region and the storage system's answer on a `'live'` one                                                                                                                     |
| `syncMemberKeys`               | —                                                                  | **new**: re-syncs a member's keys after a change to their access; a dry run returns the keys a commit would revoke, the commit takes `retainKeyIds` and returns the keys it revoked ([§7](#7-policy-lifecycle))                                                                                                                              |
| `keyGrantSync`                 | —                                                                  | **new** readonly capability, `'reissue' \| 'live'`: whether an existing key follows its member by revocation and reissue, or automatically at the enforcing system                                                                                                                                                                           |
| `IssueAccessKeyOpts`           | `keyName, permissions, granularPermissions?, buckets?, expiresAt?` | `keyName, expiresAt?`                                                                                                                                                                                                                                                                                                                       |
| `deleteAccessKey`              | idempotent revoke                                                  | unchanged in signature; the implementation deletes the store's key record with the vendor key, still idempotent ([§7](#7-policy-lifecycle))                                                                                                                                                                                                 |
| `createBucket`, `deleteBucket` | bucket lifecycle                                                   | `createBucket(tenantId, member, args)` writes the new bucket's policy and returns it; `deleteBucket` deletes it ([§6](#6-bucket-lifecycle-moves-to-the-console))                                                                                                                                                                            |
| `getS3ClientContext`           | per-tenant `filone-console` key                                    | unchanged: console-side enforcement keeps signing with it ([§3](#3-resolving-access-on-a-request))                                                                                                                                                                                                                                          |
| tenant and usage methods       |                                                                    | unchanged in signature; `deleteTenant` now also destroys the store's policy rows and key records ([§7](#7-policy-lifecycle))                                                                                                                                                                                                                |

The approximation is written once: `lib/bucket-access`, the shared store holding
`BucketPolicyTable`, the key records, and the resolution logic
([§2](#2-data-model)). All three implementations compose it today, and all three
answer `'reissue'`. The vendor underneath differs per implementation:

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
  implementation's own concern; putting the member on the call is what makes the
  mapping possible at all. Per-member users have their own preconditions:
  `CreateStorageUserArgs` requires an email and a display name, and M1 lets only
  a verified address name a credential, so a member without one keeps the shared
  user.
- **Forge** runs on the shared store until FIL-918 lands, then swaps it for
  [Hilt](https://github.com/fil-forge/hilt): policies live at the storage
  system, a key's authority derives from the member live, `keyGrantSync` answers
  `'live'`, and the implementation stores no rows, so Hilt also answers
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

The console passes the member across: a `userId` and a role. Orgs, membership,
and roles stay console-native per M1, and no implementation reads the console's
org tables. The store is the implementation's own, the way `ensureTenantReady`'s
setup state machine already is (`service-orchestrator.ts:170-188`).

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
this bucket" becomes a query and a filter rather than a read. Overlapping
policies then have to compose, which means a union rule, a member's permission
on a bucket assembled from several documents, and an admin who narrows one
document without narrowing the member. One policy per bucket makes the bucket
page the whole story and the narrowing exact. The cost is authoring effort:
granting a team eight buckets is eight edits, with no group abstraction in M2 to
collapse them.

**A key minted from one policy**, taking all or part of its permissions and
buckets and recording the version it was issued under, gives every key a
nameable source and a grant that never rounds up. It derives the credential from
the rule rather than the person, so a member whose access spans buckets holds
several credentials where an AWS customer expects one, and minting requires a
picker no S3 console has. It also does not survive a role change: a demoted
member's policy-minted keys are exactly as wrong as anyone else's, so
member-level re-sync is needed anyway, and once it exists the policy tie adds a
second divergence axis without adding control.

**Letting the caller narrow the key** is AWS's session policy, the `--policy` on
`AssumeRole`: the request names a subset of the member's buckets, and the
permission set is the intersection across the ones they named, never wider than
the member. It removes the round-up in [§4](#4-access-keys-belong-to-a-member)
exactly, and a member wanting write on one bucket gets a key that writes it. It
also puts a choice back on the credential, which is what makes a key answer to
something other than its holder, and the console has to explain why picking a
second bucket removes a checkbox. The over-grant is bounded and temporary; the
choice would not be.

**One key per distinct permission set** keeps the caller out of it and still
never rounds up: a member with read on three buckets and write on two gets two
credentials, each flat over the buckets that agree. It answers one key request
with several credentials, which no S3 client expects, and it makes the number of
credentials a person holds a function of how their admin wrote unrelated
policies.

**Caller-chosen key permissions**, the shipped model, lets a customer mint a
deliberately narrow key, a read-only credential for one app. It attaches
permissions to credentials instead of people: the console matrix is advisory
until a creation-time cap patches it (M1's `checkCreatorAuthority`), and nothing
can say what a key should become when its holder's access changes. The
narrow-key use case is better served by a principal whose access is itself
narrow ([Open questions](#open-questions)).

**A grant per member and bucket**, one row keyed `(member, bucket)`, gives the
request path an O(1) `GetItem` and needs no evaluation. It gives an admin no
rule to edit and no document to read: twelve members on eight buckets are
ninety-six rows with no shape, and nothing records that the twelve belong
together. It is also the read-path shape a per-bucket policy already provides,
without the document.

**Materializing policies into per-member rows** keeps both, policies as the
authoring layer expanded into `(member, bucket)` rows. The write amplification
rules it out, and every projection write is a chance to drift from the documents
that are the source of truth. An access-control read that can silently disagree
with its own source is worse than a bigger read.

**A `bucketScope: 'all' | 'specific'` marker on the membership row** answers "is
this caller scoped" with no I/O, since `authMiddleware` already reads that row.
It exists to disambiguate an empty policy set between "unscoped" and "scoped to
nothing", and the only caller it saves a read for is a Member stamped `'all'`, a
category that exists because the marker does. Dropping it removes a
denormalized field that can drift from the policies, a backfill, an
absent-means-all fallback, and a `member.scope_changed` event, and leaves "no
grant means no access", which is what an identity system says.

**A bucket with no policy reachable by every member** needs no backfill and
matches today's behavior exactly. It also makes
`DELETE /api/buckets/{name}/policy` a route that silently opens a bucket to the
whole org. An access-control system whose delete path fails open is the wrong
trade at any price.

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

**Reconciling policies against `ListBuckets` on read**, instead of removing the
two bucket permissions, would leave customer bucket lifecycle where it is.
Nothing available supports it. A policy naming a bucket that no longer exists is
already inert, so the failure reconciliation has to catch is the reused name,
which means telling an original bucket from a recreation. No orchestrator
exposes a stable bucket identity: `BucketSummary` carries a name and a creation
date, and a delete followed by a recreate inside the polling interval defeats
both.

**Policies as console data above the interface**, with the orchestrator taking a
pre-resolved grant on each key call, keeps the M2 interface a few lines long and
gives every policy mutation `commitAudited`'s one-transaction guarantee
directly. It leaves the approximation in the console permanently. The policy
store exists only to imitate what a real IAM backend does natively, and holding
it above the interface means M3 must push the console's policy state into the
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
   and belongs to the Forge enforcement story (FIL-1018), and nothing here
   blocks it.
6. **How many buckets an org holds before the list route's Query stops being
   cheap.** [§3](#3-resolving-access-on-a-request) reads the org's policies on
   every bucket listing by a scoped member. That number decides whether a
   per-member inverse row is ever worth its consistency risk.
7. **Whether the two bucket populations are reconciled.** Buckets predating the
   backfill carry `Allow *` and buckets created afterwards name their creator
   ([§9](#9-rollout)). Nothing reconciles them, and nothing has to.
8. **Where a deliberately narrow service credential comes from.** A key carries
   its member's access, so a customer wanting a read-only credential for one
   application has no way to mint one. Service accounts are outside the PRD's
   scope, and a principal whose own access is narrow is the shape that would
   answer it.

## References

- Tickets: FIL-1017 member bucket scope, FIL-1018 revocation timing at vendors
  and prefix enforcement, FIL-1019 privileged operations (the bucket-lifecycle
  half is decided here), FIL-1020 legacy key transition, FIL-1021 key review on
  scope change, FIL-1022 audit viewer, FIL-1024 per-region disclosure, FIL-1025
  M3 direct-key enforcement, FIL-918 Forge key update, FIL-949 request-level
  logging.
- [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md) for
  roles, the permission registry, the audit write path, and the backfill
  sequence this design follows.
- [`2026-08-privileged-operations-m2.md`](./2026-08-privileged-operations-m2.md)
  for the governance-retention bypass, whose capability
  [§1](#1-what-a-bucket-policy-is) carries as a statement action.
- Staging measurement, 2026-08-26: `ListBuckets` conformance per region
  ([§4](#4-access-keys-belong-to-a-member)).
- **The tier split source is missing.** Four M2 tickets cite a "2026-08-11
  enforcement analysis", which the M1 ADR names
  `iam-prd-enforceability-by-backend.md` in the knowledge-base repo. That repo
  holds 61 files at HEAD and none of them is it. The Tier 2 and Tier 3
  vocabulary it defines sorts work across FIL-1017 through FIL-1024, so someone
  should find it or write it again. This design does not wait on it:
  [§4](#4-access-keys-belong-to-a-member) and
  [§6](#6-bucket-lifecycle-moves-to-the-console) measured the backend behavior
  the tier split was there to decide.
