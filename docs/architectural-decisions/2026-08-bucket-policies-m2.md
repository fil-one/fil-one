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

AWS ties an access key to an IAM user. The key carries no permissions of its
own: what it can do is what its user may do, evaluated at request time, so a
permission change reaches every key the user holds without reissuing any of
them. No Service Orchestrator models that. Aurora and FTH fix a key's
permissions at issue, and their key APIs are create, list, get, and delete:
Aurora has no user object at all, and FTH's keys hang off storage users that
our integration collapses onto one shared console user per tenant
([§10](#10-the-service-orchestrator-interface)). This design adopts the AWS
shape as the product model: **an access key belongs to an org member, and a
member's keys follow their access.** The Service Orchestrator interface owns
the whole bucket-access domain: policies, effective-access resolution, and key
issuance. The console keeps orgs, membership, roles, and the audit log. An
implementation that cannot represent the domain natively approximates it over
a shared policy store
([§10](#10-the-service-orchestrator-interface)): a key's grant is synthesized
from the member's effective access when the key is created
([§4](#4-access-keys-belong-to-a-member)), and a change that narrows that
access revokes the affected keys by default ([§7](#7-policy-lifecycle)). On
Forge the approximation retires in M3 (FIL-918, FIL-1025): policy enforcement
moves into the storage system itself, and a key's authority derives from the
member live.

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
(`fth-orchestrator.ts:227`, `aurora-orchestrator.ts:200`,
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
   ([§1](#1-what-a-bucket-policy-is), [§3](#3-resolving-access-on-a-request)).
3. **Owner and Admin are unscoped by role**, and a membership row saying
   `bucketScope: 'all'` is unscoped. Policies apply to everybody else
   ([§2](#2-data-model)).
4. **Enforcement is the console API plus the key's permission set.** A handler
   refuses a request naming a bucket outside the caller's union, and orchestrator
   results are filtered against it on every request. The tenant-wide console
   credential is not narrowed, which is M3's work; keys already issued follow
   Decision 6's re-sync, and pre-attribution keys wait for FIL-1020
   ([§3](#3-resolving-access-on-a-request)).
5. **An access key belongs to a member.** A key is minted for the caller, in one
   region, with no permission choices on the request. The orchestrator
   synthesizes its grant at issue from the member's effective access:
   tenant-wide under the role's permissions for an unscoped
   member, the union of their bucket policies for a scoped one, with the role
   as ceiling in both cases ([§4](#4-access-keys-belong-to-a-member)).
6. **A member's keys follow their access.** Every change to a member's effective
   access, from a role change to a policy edit, re-syncs their keys. No
   orchestrator today can edit a key in place, so a narrowing revokes the keys
   it strands, **by default**, with a per-key opt-out, and a widening leaves
   keys carrying less than the member until they re-mint. Member removal keeps
   FIL-1021's flow and the bucket sweep stays silent ([§7](#7-policy-lifecycle)).
   Once Forge derives a key's authority from the member live (FIL-918), its
   region re-syncs nothing ([§10](#10-the-service-orchestrator-interface)).
7. **Policies live behind the Service Orchestrator interface.** The console
   authors them through it, and a shared policy store backs all three
   implementations today: one row per policy plus a roster row, its inverse,
   and the member's key records,
   in a table of the store's own ([§2](#2-data-model),
   [§10](#10-the-service-orchestrator-interface)). After M3 the Forge
   implementation answers the same calls from Hilt and stores
   no rows.
8. **Org-wide aggregates stay org-wide.** Usage, billing, and dashboard counts
   are not scoped ([§5](#5-what-a-scoped-member-can-still-see)).
9. **Enumeration over S3 is a name listing rather than an access boundary.** The
   key's `buckets` array governs what the key can operate on, which both measured
   backends enforce. Whether a gateway also filters `ListBuckets` is a contract
   item worth pursuing and nothing here depends on it
   ([§4](#4-access-keys-belong-to-a-member)).
10. **`CreateBucket` and `DeleteBucket` come off customer access keys**, in every
    region, until an orchestrator can report a bucket's lifecycle and the key
    that changed it (FIL-1019). Every bucket's creation and deletion then runs
    through a FilOne handler, which is where the new bucket joins a policy and
    where the `bucket.created` and `bucket.deleted` events are appended
    ([§6](#6-bucket-lifecycle-moves-to-the-console)).
11. **The Service Orchestrator interface owns the bucket-access domain.**
    Policy CRUD, effective-access resolution, key issuance, and the key
    records all cross it, carrying the member; the console keeps orgs,
    membership, roles, and the audit log, and how faithfully a backend
    represents the domain is declared on the interface
    ([§10](#10-the-service-orchestrator-interface)).
12. **Audit stays console-written.** Every mutation that crosses the interface
    gets M1's intent-and-completion pair around the call, and `commitAudited`
    keeps the mutations that never cross it ([§8](#8-audit-events)).

### 1. What a bucket policy is

A **bucket policy** belongs to an org and holds a name, one region, a set of
bucket names in that region, a permission set, and a roster. A policy holding no
buckets is valid: it keeps its roster and its permissions while an admin decides
what to point it at. Policy names need not be unique within an org, since the
policy id is the identity; the console warns on a collision rather than refusing
one. A policy is addressed with its region, since the id alone does not say
which orchestrator holds it.

The **roster** is the org members the policy applies to. A member can be on
several rosters, including two policies that name the same bucket.

The **version** is an integer on the policy row, bumped when the permission set
or the bucket set changes and left alone when the roster changes. It exists so
an edit is precise on the record: audit events name the version they produced
([§8](#8-audit-events)), and concurrent edits lose cleanly on its conditional
bump.

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

The shared policy store owns this table. Nothing above the interface reads
it: the store is `lib/bucket-access`, the module every orchestrator
implementation composes today
([§10](#10-the-service-orchestrator-interface)). After M3 the Forge
implementation answers the same calls from Hilt and writes no rows here, so
the table holds data only for the regions that still approximate. It is
FilOne infrastructure all the same: declared in `sst.config.ts`, backed up,
torn down with the tenant ([§9](#9-rollout)).

Policies live in a new `BucketPolicyTable`, `pk`/`sk` with no secondary index,
following the house pattern where a second access path is an inverse item.
Four row families are the store's; the `OrgTable` row is the console's
marker, shown because the resolver takes it as input
([§3](#3-resolving-access-on-a-request)). RAG key rows stay in
`UserInfoTable`, being console bearer credentials outside the domain
([§4](#4-access-keys-belong-to-a-member)).

| Table               | pk                              | sk                  | Attributes                                                                                                   | Purpose                                                  |
| ------------------- | ------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `BucketPolicyTable` | `ORG#{orgId}`                   | `POLICY#{policyId}` | `name`, `region`, `buckets`, `permissions`, `granularPermissions`, `version`, `createdBy/At`, `updatedBy/At` | the policy                                               |
| `BucketPolicyTable` | `ORG#{orgId}#POLICY#{policyId}` | `MEMBER#{userId}`   | `addedBy`, `addedAt`                                                                                         | the roster                                               |
| `BucketPolicyTable` | `ORG#{orgId}#MEMBER#{userId}`   | `POLICY#{policyId}` | `addedBy`, `addedAt`                                                                                         | inverse: a member's policies, the request read           |
| `BucketPolicyTable` | `ORG#{orgId}#MEMBER#{userId}`   | `KEY#{keyId}`       | `keyName`, `region`, stamped grant, `createdBy/At`, `creatorEmail?`, `expiresAt?`, `recovered?`              | the key record ([§4](#4-access-keys-belong-to-a-member)) |
| `OrgTable`          | `ORG#{orgId}`                   | `MEMBER#{userId}`   | `bucketScope`                                                                                                | whether policies apply                                   |

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
membership row, so `bucketScope: 'all'` answers with no I/O at all, and only
a scoped caller on a bucket-addressed or fan-out route reaches the resolver.
The marker is console data, an input the console passes into resolution.
`'specific'` with no policies is a member who sees no bucket, and it fails
closed. Evaluating
`'all'` per request also means a bucket created after the marker was written is
inside the scope by definition.

**Policies get their own table** because the store belongs to the
orchestrator implementations and cannot live in a console table. Separation
also keeps load where it belongs: policies per org and rosters per policy are
both unbounded, and in `OrgTable` they would share the `ORG#{orgId}` partition
with the membership, invitation, and `META` rows that every authenticated
request already reads.

During rollout, a membership row carrying no `bucketScope` means `'all'`, since
every row written before this work carries no marker and today every member sees
every bucket. The backfill stamps `'all'` on every row and the following PR
removes the fallback, the sequence M1 used for the role fallback
([`2026-08-organizations-roles-m1.md`
§2](./2026-08-organizations-roles-m1.md#2-roles-and-the-permission-registry)).

### 3. Resolving access on a request

Resolution is an interface call, `resolveMemberAccess`
([§10](#10-the-service-orchestrator-interface)), answered today by the shared
policy store. The console passes the member's console-owned facts, the role
and the `bucketScope` marker, and gets back the map:

```ts
export type BucketAccess =
  | { sees: 'all' }
  | { sees: 'policies'; buckets: Map<string, Set<AccessKeyPermission>> };
```

One orchestrator answers for one region, so a fan-out route asks each
provisioned orchestrator and a bucket-addressed route asks one. On a region
whose policies live at the storage system (M3 Forge), the same call becomes a
vendor read on the request path; what that costs is M3's to measure. Whoever
answers, the read must reflect the caller's latest change, so a removal binds
on their next request: the store meets that with `ConsistentRead`
([§2](#2-data-model)), and a `'live'` backend must promise it natively.

Owner and Admin are unscoped by role, a caller whose membership row says `'all'`
is unscoped, and everyone else resolves against their policies. An unscoped
caller's policy rows are never read, on any route, because the role and the
marker settle the answer in the console before the interface is crossed.
Nobody deletes them either,
since promoting a member out of a scope leaves their rosters in place
([§7](#7-policy-lifecycle)).

A scoped caller costs two reads inside the store: one `Query` on
`ORG#{orgId}#MEMBER#{userId}` for their policy ids, and one `BatchGetItem` on
those policy rows, unioned into the map above, keyed `{region}/{bucketName}`.
The console caches the returned map for the request. Both reads are bounded
by policies-per-member, a number an admin controls rather than one that grows
with usage, and the map answers both questions a route asks: is this bucket
in reach, and with which permissions.

The check runs in the handler rather than in middleware, because `authorize()`
decides from the route manifest alone and the manifest cannot name a bucket,
while the bucket arrives in a path parameter or, for `POST /api/presign`, in
each element of the body. This is the `in-handler` requirement M1 already
defines for presign.

| Route                                                    | Scoped behavior                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/buckets`                                       | filter the merged fan-out result to the resolved set                                                                                             |
| `POST /api/buckets`                                      | allowed; the creator names one of their policies for the new bucket ([§6](#6-bucket-lifecycle-moves-to-the-console))                             |
| `GET /api/buckets/{name}`                                | absent from the set gives the same 404 a missing bucket gives                                                                                    |
| `DELETE /api/buckets/{name}`                             | gated on `buckets.delete`, which only an unscoped caller holds                                                                                   |
| `GET /api/buckets/{name}/analytics`                      | 404                                                                                                                                              |
| `GET \| POST /api/buckets/{name}/rag/enabled`            | 404                                                                                                                                              |
| `POST /api/buckets/{name}/bulk-delete`                   | 404                                                                                                                                              |
| `GET /api/bulk-delete-jobs/{jobId}`                      | the job row names its bucket; check that bucket, 404 otherwise                                                                                   |
| `GET /api/activity`                                      | filter the bucket entries to the resolved set                                                                                                    |
| `POST /api/presign`                                      | per operation, the bucket in the set and the effective permission for it; one denial refuses the batch                                           |
| `POST /api/buckets/{name}/query` (bearer)                | the bearer branch resolves the key creator's membership row, so that member's live access applies                                                |
| `POST /api/access-keys`                                  | minted for the caller from their effective access; a scoped caller with no reachable bucket is refused ([§4](#4-access-keys-belong-to-a-member)) |
| `POST /api/rag-api-keys`                                 | bucket refs must sit inside the caller's effective access; same refusal                                                                          |
| `POST /api/org/invitations`                              | carries the invited member's policy ids ([§7](#7-policy-lifecycle))                                                                              |
| `PATCH /api/org/members/{userId}`                        | role changes; any change to the member's effective access runs the key re-sync ([§7](#7-policy-lifecycle))                                       |
| `GET \| POST /api/bucket-policies`                       | list and create, `policies.manage`                                                                                                               |
| `GET \| PATCH \| DELETE /api/bucket-policies/{policyId}` | read, edit, delete, `policies.manage`                                                                                                            |
| `POST \| DELETE /api/bucket-policies/{policyId}/members` | roster changes, `policies.manage`                                                                                                                |

The `bucket-policies` routes carry the policy's region alongside the id, the
way presign carries one, since the id alone does not name the orchestrator
that holds the policy ([§1](#1-what-a-bucket-policy-is)).

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
policies still grants what was removed. A member's key is synthesized from the
same union, so console and key agree at issue; where the union grants different
verbs on different buckets, the key's flat permission set rounds up
([§4](#4-access-keys-belong-to-a-member)). Both facts belong in the console copy
beside the policy editor.

### 4. Access keys belong to a member

A key request carries a name, a region, and an optional expiry, and nothing
else: `permissions`, `granularPermissions`, `buckets`, and `bucketScope` all
leave `CreateAccessKeySchema`. The caller chooses nothing about the grant.
The orchestrator synthesizes it from the caller's effective access in the
requested region, by the same resolution the request path uses
([§3](#3-resolving-access-on-a-request)), and stamps it on the vendor key
([§10](#10-the-service-orchestrator-interface)):

- An **unscoped caller** (Owner, Admin, or a member marked `'all'`) gets a
  tenant-wide key with no bucket list. Its permission set is the inverse of
  M1's requirement maps: every key permission whose console requirement the
  caller's role holds, granulars included (`ACCESS_KEY_PERMISSION_REQUIREMENT`
  and `GRANULAR_ELEVATIONS`,
  `packages/shared/src/access-key-permissions.ts:27-70`), minus `CreateBucket`
  and `DeleteBucket` (Decision 10).
- A **scoped caller** gets the union of their policies in that region: the
  key's `buckets` array is the union of the bucket lists, and its permission
  set is the union of what those policies grant, intersected with the role's
  mapped permissions.
- **The role is a ceiling.** Org-level
  permissions reach a key only where the member is unscoped; a scoped member's
  key carries what their policies grant and no more, which keeps
  [§1](#1-what-a-bucket-policy-is)'s rule that a Member on a read-only policy
  cannot write.
- A scoped caller whose union in that region is empty is refused, naming the
  reason rather than answering a permission error: they hold `keys.create` and
  there is nothing to point a key at. The one policy such a member can bring
  into being is the one attached to a bucket they create
  ([§6](#6-bucket-lifecycle-moves-to-the-console)), which puts them on its
  roster in the same request.
- The two mutating granulars keep M1's rule under synthesis:
  `PutObjectRetention` and `PutObjectLegalHold` enter a grant only for an
  Owner, whose role holds `privileged.grant`, until FIL-1019 replaces the
  blanket elevation with per-operation grants.

**A ReadOnly member cannot mint a key at all**, per M1's matrix, so their policy
rosters govern the console alone.

**The key's permission set is flat because the vendor primitive is flat**: one
permission list over one bucket array (`IssueAccessKeyOpts`). Where a member's
policies grant different verbs on different buckets (read on one, write on
another), the key rounds up to the union across them, and the difference binds
only at the console. That is the approximation's one over-grant. It is bounded
by the member's own policies, and it ends where enforcement moves into the
storage system, since M3's direct-key enforcement (FIL-1025, on FIL-918) reads
a key's authority from the member exactly.

M1's creation-time cap disappears by construction. `checkCreatorAuthority`
(`handlers/create-access-key.ts:207-222`) refused any requested permission the
creator did not hold in the console; now there is no requested set to cap, and
the grant cannot exceed the member because it is computed from the member.

**The key record lives in the store and names the member.** It carries the
attribution M1 already writes (`createdBy`) plus the stamped grant, and it
moves from `UserInfoTable` into the store with the rest of the domain
([§9](#9-rollout), [§10](#10-the-service-orchestrator-interface)). Nothing
ties a key to a policy: divergence is measured against the member, by
comparing the stamped grant to their live effective access, and the console
shows it on the key list when an opt-out or a widening has left a key behind
([§7](#7-policy-lifecycle)). On a region whose keys derive from the member
live, the stamp means nothing: a key read answers with effective permissions
from the storage system, so the console reads one shape everywhere. A
`recovered` record's attribution names the caller who retried rather than a
confirmed creator (`lib/dynamo-records.ts:54-59`), so the re-sync treats
recovered records like unattributed ones: counted in the dialog, never
auto-revoked.

RAG API keys are already on this model. Their schema carries no permissions at
all (`packages/shared/src/api/rag-api-keys.ts:37-68`), and the bearer branch
resolves the creator's live membership on every query, refusing when it is gone
(`middleware/rag-query-auth.ts:112-178`). This design brings the SigV4 key to
the model the bearer key already has. A RAG key's own bucket refs stay what
they are, the buckets the index serves, validated against the creator's
effective access at creation and narrowed by their live access at query;
because the authority resolves live, RAG keys sit outside
[§7](#7-policy-lifecycle)'s re-sync.

Aurora's keys are immutable and our FTH integration has no key update
([§10](#10-the-service-orchestrator-interface)), so a key cannot change when
its member does. Making keys follow the member on those backends means
revoking and reissuing them, which is [§7](#7-policy-lifecycle)'s re-sync.
Forge gets
out of that once FIL-918 lands. Its requirement is a key whose authority
derives from the member at the enforcing system, and a key read that returns
effective permissions from there instead of from our record. The console flow
is then one flow with two regional outcomes, a difference FIL-1024's
per-region matrix has to show.

**Both measured backends enforce the key's bucket list against object
operations.** Aurora and FTH were measured on staging (2026-08-26):

| Region                 | Refuses an out-of-scope object read | Lists only the key's buckets   |
| ---------------------- | ----------------------------------- | ------------------------------ |
| `eu-west-1` (Aurora)   | yes                                 | yes                            |
| `us-east-1` (FTH)      | yes                                 | no, the whole tenant came back |
| `eu-central-3` (Forge) | untested                            | yes                            |

A scoped key reading a bucket it does not name is refused, which is the
property the synthesized grant depends on. Whether Forge also refuses is
unmeasured, and being ours an unwanted answer there is a bug to fix; M3's
direct-key enforcement (FIL-1025, on FIL-918) is where the gateway reads a
key's scope from the system enforcing it.

**Enumeration is a name listing rather than an access boundary.** `aws s3 ls`
reaches the storage gateway directly and never touches a FilOne handler, so the
route table above does nothing for it, and every key FilOne mints carries
`s3:ListAllMyBuckets` unconditionally (`ALWAYS_PERMISSIONS`,
`orchestrator/orchestrator.ts:497`; `FTH_ALWAYS_PERMISSIONS`,
`fth-orchestrator.ts:382`; on Aurora the action rides inside the `Default`
grant, `aurora-portal.ts:107`, whose contents `aurora-portal.swagger.json`
documents). On FTH a scoped key therefore lists every bucket in
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
([§4](#4-access-keys-belong-to-a-member)). Neither is closed. `aws s3 ls`
against AWS lists names the caller cannot act on too.

Presigned URLs already issued stay valid until they expire, up to 7 days for
downloads (`handlers/presign.ts:40`), which is the real revocation bound for
object reads after a policy change. A member's SigV4 keys re-sync with the
change itself ([§7](#7-policy-lifecycle)); how fast a revocation binds at the
vendor is FIL-1018's open number, and presign lifetime is the bound the design
controls.

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
A policy created this way needs a permission set; the creator chooses one,
capped by their role's permissions, the ceiling every grant obeys.
`createBucket` refuses a policy the creator is not on, or one in another
region, and returns the joined policy's id and version, so the
`bucket.created` event can name it; a policy born this way writes its own
`bucket_policy.created`. An
unscoped creator names none, and the bucket is theirs to see the way every bucket
is.

Naming the policy explicitly puts the blast radius in front of the person
creating the bucket. Adding the bucket to every policy the creator is on would
grant it to everybody else on those rosters without anyone asking.

Creating a bucket is also the one path by which a scoped member reaches a first
policy. Policy creation is otherwise `policies.manage`, held by Owner and Admin,
so a member on no roster either waits for an admin to put them on one or creates
a bucket and gets the policy that comes with it. Until one of those happens they
see no bucket and can mint no key ([§4](#4-access-keys-belong-to-a-member)).

The policy write happens **before** the bucket exists and is undone if
creation fails. The orchestrator owns both writes, so it keeps the ordering.
A policy naming a bucket that does not exist grants nothing, so
the pre-write is safe in a way the post-write is not: a write that fails after a
successful create leaves a member unable to see the bucket they just made. The
two steps cannot be one transaction, because the bucket lives at the vendor, so
what survives a failure is a bucket name left in a policy, inert until a bucket
of that name exists in that region.

**Bucket deletion removes the name from every policy that holds it.** The
sweep rides inside the implementation's `deleteBucket`, which holds both the
bucket and the policies naming it: it queries the org's policies, updates the
ones naming the bucket, bumps each version, and revokes nothing
([§7](#7-policy-lifecycle)). It is bounded by policies per org rather than by
anything that grows with usage, and it sits outside the delete's own
atomicity.

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

The change is small and reversible. `CreateBucket` and `DeleteBucket` leave
the synthesized grant ([§4](#4-access-keys-belong-to-a-member)),
`BUCKET_PERMISSIONS` (`packages/shared/src/api/access-keys.ts`) is deleted
with `supportsBucketManagement` and its callers, and nothing is left to gate.
Re-enabling is the same edit backwards, with no migration
either way. A denied attempt answers with the vendor's `AccessDenied`, the S3
error FIL-1019's acceptance criteria ask for.

Customers scripting bucket lifecycle against the S3 API lose that capability. The
product ships it today in the FTH and Forge regions. The Console API is
session-authenticated, so no credential FilOne issues reaches `POST /api/buckets`
either, and scripted bucket lifecycle has no supported path until an orchestrator
reports lifecycle events and the permission can return. Keys already carrying
the two permissions keep them until FIL-1020 retires them, and the re-sync
comparison ignores the two until then ([§7](#7-policy-lifecycle)). The
console labels the two as legacy on the keys that hold them, which gives
FIL-1021's key review something to act on.

With every create and delete passing through a handler, `bucket.created` and
`bucket.deleted` become writable for the first time. Each carries the acting
user, the region, the bucket name, and the timestamp, and the create event names
the policy the bucket joined.

### 7. Policy lifecycle

**Invite.** An invitation carries the region-qualified policy ids the new
member should join, on
the row M1 already writes at `ORG#{orgId}` / `INVITE#{inviteId}`, alongside the
`bucketScope` marker. Acceptance adds the member to whichever of those policies
still exist and reports the ones it skipped. An invitation is an intent rather
than a contract: a policy deleted during the 14-day window is an admin's
deliberate act, and failing the acceptance would punish the invitee for it.

Acceptance lands the membership first with its marker, and the roster rows
follow as interface calls, which no console transaction can span. That order
makes the failure safe: a member whose marker says
`'specific'` and whose rosters have not been written yet sees no bucket, and the
invitation row survives acceptance, so the policies it names are still there to
re-drive. An Owner or Admin invitation carries no policies at all, since both
roles are unscoped.

**Editing a policy's permissions or buckets, changing a roster, deleting a
policy, changing a role, and changing the scope marker all run the same
re-sync.** Each one changes some members' effective access, and every affected
member holds SigV4 keys stamped with the access they had before
([§4](#4-access-keys-belong-to-a-member)). RAG keys sit outside the re-sync:
their authority resolves from the creator's live membership at query time
([§4](#4-access-keys-belong-to-a-member)), so nothing stamped can diverge.

A policy change re-syncs inside the call that makes it: the mutation takes
the key ids to retain and returns the keys it revoked, with
`previewPolicyChange` feeding the dialog first
([§10](#10-the-service-orchestrator-interface)). An org-level change (role or
marker) is console data, so the console runs `syncMemberKeys` on each
provisioned orchestrator for that member, dry-run first to fill the dialog.
Either way the implementation reads the member's key records from its store
([§4](#4-access-keys-belong-to-a-member)) and compares each stamp to the
member's recomputed grant:

- **A narrowing revokes the stranded keys by default.** The dialog lists the
  keys whose stamped grant exceeds the recomputed one, selected. Revocation is
  the default because a retained key keeps reaching buckets the member no
  longer has. Unticking a key is the per-action escape for a client an admin
  cannot afford to break, and an unticked key stays visibly divergent on the
  key list until revoked or re-minted. The mutation enforces the same default:
  it revokes every stranded key unless the request names the
  key ids to retain, so an API caller gets revocation by omission rather than
  retention. The comparison ignores `CreateBucket` and `DeleteBucket` on a
  legacy key, which FIL-1020 owns
  ([§6](#6-bucket-lifecycle-moves-to-the-console)), and unattributed and
  recovered records sit outside the default set, revoked only when named
  explicitly ([§4](#4-access-keys-belong-to-a-member)).
- **A widening leaves keys in place.** The stranded key then carries less than
  the member rather than more. Revoking it would break a client to grant
  nothing, since reissue means a new credential either way. The key list shows
  the divergence, and re-minting is the member's own step. Adding a bucket to
  a policy, including through `POST /api/buckets`
  ([§6](#6-bucket-lifecycle-moves-to-the-console)), is a widening.

Whether a particular change strands anything falls out of the comparison
rather than a rule: demoting an Owner to Admin diverges only keys that carried
the privileged granulars, and a demotion into a retained marker of `'all'` can
recompute to the identical grant and touch nothing.

When revocation proceeds, the implementation revokes at the vendor before
writing the change locally, and the console's audit intent brackets the whole
call ([§8](#8-audit-events)). Revocation is a vendor call, so the two steps
cannot be one transaction, and that order keeps a partial failure safe: a
failed revoke leaves the policy and the keys where the operation started,
while writing first would narrow the console while a key still reaches the
dropped bucket at the gateway. Re-driving is safe because `deleteAccessKey`
already promises that deleting an already-deleted key counts as success. How
fast a revocation binds at the provider is what FIL-1018 is still asking
vendors, and it has no answer yet. The console's own cached bucket list
survives until the next refetch.

Keys minted before M1 have no owner and never will, so the dialog cannot list
them, and those are the keys a policy review most wants to see. The
dialog therefore carries the org's unattributed key count beside the named list,
so an admin reads "3 keys can be revoked, 7 keys in this org have no recorded
owner and are not checked" instead of a list that looks complete. Recovered
rows count among the unchecked, since their attribution is a guess
([§4](#4-access-keys-belong-to-a-member)). Labelling those
keys and restricting them to Owners and Admins is FIL-1020.

**The bucket sweep is the one narrowing that stays silent**, and only while a
deleted name cannot be reclaimed
([§6](#6-bucket-lifecycle-moves-to-the-console)): the keys naming a swept
bucket reach nothing, so there is nothing to revoke and nobody to ask. It
rides inside `deleteBucket` rather than through `updatePolicy`'s
revoke-by-default. A vendor that starts reclaiming names turns the sweep into
an ordinary narrowing, dialog and all.

**Demotion** out of an unscoped role runs the re-sync as a narrowing, because
demoting an Admin to Member activates their rosters while the keys they minted
while unscoped are tenant-wide, so the dialog opens with those keys selected.
The `PATCH /api/org/members/{userId}` response also opens the policy picker so
the admin can put the demoted member where they belong; a member on no roster
sees no bucket, and that fails closed.

**Promotion** leaves the policy rows in place. The marker and every roster row
stay as they are, and the new role means nothing reads them. Enforcing a policy
against an Admin would protect nothing anyway, since an Admin holds
`policies.manage` and can add themselves to any policy in one request.
Retention lets a later demotion reuse the old rosters, and the console renders
a promoted member's policies as inactive rather than hiding them. The keys the
member minted while scoped follow the widening rule: they keep working, carry
less than the new role, and show as divergent until re-minted.

**Removing a member** from the org leaves roster rows behind, since no
console transaction can span the interface, so `removeMemberFromPolicies`
follows the removal on each provisioned orchestrator
([§10](#10-the-service-orchestrator-interface)). An orphaned roster row
grants nothing on its own, because `authorize()` refuses a caller with no
membership row, but it would revive if that user rejoined the org, so a
scheduled console job re-drives the call for users no longer in the org, and
a missed sweep is still collected. Member removal revokes keys through
FIL-1021's flow instead of this one's, and a removed member's key records
stay in the store, visible under the tenant filter like unattributed ones,
until that review revokes the keys.

**Deleting an org** needs no new path: `deleteTenant` already destroys
everything a tenant owns, and the store's rows are the implementation's own
to delete with it.

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
that is a per-member fact no policy event carries; it and `member.role_changed`
carry revoked key ids the way the policy events do, since a role or marker
change can revoke keys exactly as a policy edit can
([§7](#7-policy-lifecycle)). `member.invited` and
`invite.accepted` gain the policy ids, and `bucket.created` and `bucket.deleted`
are defined in [§6](#6-bucket-lifecycle-moves-to-the-console);
`bucket.deleted` names the policies swept and the versions they moved to,
which is what keeps the replay exact.

Every policy mutation crosses the interface, so the console writes each event
in M1's intent-and-completion shape around the call: the intent before the
mutation, the completion after, carrying what the mutation reports back: the
revoked key ids, and the new version where the mutation bumped one. A role or
marker change carries revoked key ids from `syncMemberKeys`, so its event
takes the same shape; `commitAudited`'s single-transaction guarantee stays
with the mutations that never cross the interface, and the price of giving it
up here is named in [Options considered](#options-considered). A crash
between intent and completion leaves a visible dangling intent instead of a
mutation with no record.

Denials are not logged. A scoped member hitting a bucket outside their policies
gets a 404, and one event per 404 turns the audit log into a traffic log.
FIL-1022 scopes itself to control-plane events, and request-level logging is
FIL-949.

### 9. Rollout

The M1 sequence applies unchanged: ship the table and the write path, backfill
`bucketScope: 'all'` onto every membership row under `sst shell` with a dry run
and a verify pass, confirm the stamp, then ship enforcement with the
absent-means-all fallback removed. No policy exists on day one, and until an
Owner or Admin creates one and puts somebody on it, the policy enforcement
changes nothing observable, so that PR merges independently. The key-model
change ships visibly: the interface changeset
([§10](#10-the-service-orchestrator-interface)) and the shrunken key form are
observable the day they land, whatever policies exist, so they go as their
own PR ahead of the policy surface, where a synthesized grant is simply the
caller's role-mapped set. The store's table ships with that PR, since it
holds the key records; the policy rows arrive when policies do. The key
records move from `UserInfoTable` into the store with a backfill, on M1's
script-only-PR-then-dependent-PR sequence.

The table ships with point-in-time recovery, the way `OrgTable` did, and with
an IAM grant narrowed to the operations `lib/bucket-access` performs instead
of the shared `allResources` link. The teardown reaches the store through
`deleteTenant`, and the roster re-drive job ([§7](#7-policy-lifecycle)) is
wired in the same PR that creates the table, before any row exists.

The console surface is a **Bucket policies** page at org level, the editor for
a policy's rule and roster: name, region, buckets, permissions, and members in
one place, with the narrowing dialog on save. A policy can also come into
being on the bucket-create path
([§6](#6-bucket-lifecycle-moves-to-the-console)), and it lands in this editor
like any other. Two read-only views feed off it, "which
policies name this bucket" on the bucket detail page and "which policies is this
person on" on the member detail page. The views stay read-only, since an edit
there changes what everybody on the roster reaches. All three sit behind the
`ORGS_BETA` row pattern (`lib/orgs-beta.ts`), where granting is a row instead
of a redeploy.

The key creation form shrinks to a name, a region, and an optional expiry. The
permission checkboxes and the bucket picker leave the form: the grant comes
from who the caller is ([§4](#4-access-keys-belong-to-a-member)), and the form
shows what the key will reach before it is minted.

### 10. The Service Orchestrator interface

The interface today is tenant-addressed on every key call:
`issueAccessKey(tenantId, opts)` takes the caller-chosen permission and bucket
lists (`IssueAccessKeyOpts`, `lib/service-orchestrator.ts:66-72`), and nothing
on the interface names a user or a policy. The changeset gives it the
bucket-access domain:

| Type or method                 | Today                                                              | Becomes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveMemberAccess`          | —                                                                  | **new**: `(tenantId, member)` returns the `BucketAccess` map for this region ([§3](#3-resolving-access-on-a-request)). `member` is `{ userId, role, bucketScope }`, the console-owned facts resolution needs                                                                                                                                                                                                                                                                                                        |
| policy surface                 | —                                                                  | **new**: `createPolicy`, `getPolicy`, `listPolicies`, `listPoliciesForMember`, `updatePolicy`, `deletePolicy`, roster add/remove, and `removeMemberFromPolicies` for the removal sweep. The console routes each call by the policy's region. Mutations take `retainKeyIds` and return the keys they revoked and the version they produced; `previewPolicyChange` returns the version it read, which the mutation takes as its condition, so a stale preview fails instead of committing ([§7](#7-policy-lifecycle)) |
| `issueAccessKey`               | `(tenantId, opts)`                                                 | `(tenantId, member, opts)`: the grant derives from the member inside the call ([§4](#4-access-keys-belong-to-a-member)), and nothing about it is the caller's to choose                                                                                                                                                                                                                                                                                                                                             |
| `listAccessKeys`               | —                                                                  | **new**: `(tenantId, filter)`, the filter naming a member or the whole tenant; returns key records with their effective permissions, the stamp on a `'reissue'` region and the storage system's answer on a `'live'` one. Unattributed and recovered records come back under the tenant filter ([§4](#4-access-keys-belong-to-a-member))                                                                                                                                                                            |
| `syncMemberKeys`               | —                                                                  | **new**: re-syncs a member's keys after an org-level change; a dry run returns the keys a commit would revoke and fills the dialog, the commit takes `retainKeyIds` and returns the keys it revoked ([§7](#7-policy-lifecycle))                                                                                                                                                                                                                                                                                     |
| `keyGrantSync`                 | —                                                                  | **new** readonly capability, `'reissue' \| 'live'`: whether an existing key follows its member by revocation and reissue, or automatically at the enforcing system                                                                                                                                                                                                                                                                                                                                                  |
| `IssueAccessKeyOpts`           | `keyName, permissions, granularPermissions?, buckets?, expiresAt?` | `keyName, expiresAt?`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `deleteAccessKey`              | idempotent revoke                                                  | unchanged in signature; the implementation deletes the store's key record with the vendor key, still idempotent ([§7](#7-policy-lifecycle))                                                                                                                                                                                                                                                                                                                                                                         |
| `findAccessKeyByName`          |                                                                    | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `createBucket`, `deleteBucket` | bucket lifecycle                                                   | `createBucket(tenantId, member, args)`: `args` gains the policy join, an existing policy id or a new policy to create, and the call returns the joined policy's id and version. `deleteBucket` gains the silent policy sweep; bucket reads unchanged ([§6](#6-bucket-lifecycle-moves-to-the-console))                                                                                                                                                                                                               |
| `getS3ClientContext`           | per-tenant `filone-console` key                                    | unchanged: console-side enforcement keeps signing with it ([§3](#3-resolving-access-on-a-request))                                                                                                                                                                                                                                                                                                                                                                                                                  |
| tenant and usage methods       |                                                                    | unchanged in signature; `deleteTenant` now also destroys the store's policy, roster, and key rows ([§7](#7-policy-lifecycle))                                                                                                                                                                                                                                                                                                                                                                                       |

The approximation is written once: `lib/bucket-access`, the shared policy
store holding `BucketPolicyTable`, the key records, and the resolution logic
([§2](#2-data-model)). All three implementations compose it today, and all
three answer `'reissue'`. The vendor underneath differs per implementation:

- **Aurora** has no user object and no key update; the Portal API's key
  surface is create, list, get-by-id, and delete (aurora-portal-client
  `sdk.gen.ts:1002-1063`). The implementation stamps the grant onto the key
  (base plus granular plus `AURORA_ACCESS_ALWAYS`,
  `lib/aurora/aurora-portal.ts:107`), and the member travels no further than
  the key row.
- **FTH**'s client is also create, list, get, and delete
  (`fth-management-client.ts:29-40`), but FTH is the one vendor with a user
  object. Keys already hang off a storage user, today the single shared
  `filone-console` user per tenant (`fth-orchestrator.ts:227-250, 453-467`),
  and the client already provisions users (`createStorageUser`,
  `fth-management-client.ts:25`, args at `:191-198`). Whether the
  implementation maps members onto per-member storage users or keeps the
  shared one is the implementation's own concern; putting the member on
  the call is what makes the mapping possible at all. Per-member users have
  their own preconditions: `CreateStorageUserArgs` requires an email and a
  display name, and M1 lets only a verified address name a credential, so a
  member without one keeps the shared user.
- **Forge** runs on the shared store until FIL-918 lands, then swaps it for
  [Hilt](https://github.com/fil-forge/hilt): policies live at the storage
  system, a key's authority derives from the member live, `keyGrantSync`
  answers `'live'`, and the implementation stores no rows, so Hilt also has
  to answer `listAccessKeys`: attribution, key name, and expiry come back
  with the effective permissions, and only the stamped grant disappears. The
  re-sync dialog stops appearing in that region, since nothing strands. That is the genuine
  per-region difference, M3's work makes it visible, and `keyGrantSync` is
  the fact FIL-1024's per-region matrix reads. `'live'` has no implementer
  until FIL-918, so the console's quiet branch exists from day one and first
  runs in M3.

The console flow branches once, on `keyGrantSync`: `'live'` re-syncs nothing;
`'reissue'` opens [§7](#7-policy-lifecycle)'s revocation dialog. No other
console code branches on the region.

The console passes the member across: a `userId`, the role, and the
`bucketScope` marker. Orgs, membership, and roles stay console-native per M1,
and no implementation reads the console's org tables. The store is the
implementation's own, the way `ensureTenantReady`'s setup state machine
already is (`service-orchestrator.ts:170-188`).

Callers change with it. `create-access-key.ts` drops `checkCreatorAuthority`
([§4](#4-access-keys-belong-to-a-member)); the two-phase audit shape carries
to every policy mutation ([§8](#8-audit-events)). `CreateAccessKeySchema`
shrinks with `IssueAccessKeyOpts`, and the bucket-policy routes in
[§3](#3-resolving-access-on-a-request)'s table become thin handlers over the
policy surface. The key records move out of `UserInfoTable` into the store
([§4](#4-access-keys-belong-to-a-member), [§9](#9-rollout)), so
`list-access-keys.ts` calls `listAccessKeys` on each provisioned
orchestrator and merges, the way `list-buckets.ts` does, and the
`keys.manage_own` narrowing keeps working over the merged records.
`test/fake-orchestrator.ts` is untyped against the interface and stubs none
of the key methods, so it gains stubs for the methods its tests exercise.

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

**One policy per bucket**, which is what S3 means by the term, is the simplest
possible rule: one bucket, one permission set, one roster. It also means an
admin granting a team access to eight buckets writes eight policies with eight
identical rosters, and every team change is eight edits. A policy over a set of
buckets in one region loses nothing, because the key's synthesized grant
already carries one flat permission set over a bucket array
([§4](#4-access-keys-belong-to-a-member)).

**A key minted from one policy**, taking all or part of its permissions and
buckets and recording the policy version it was issued under, gives every key
a nameable source, a version to snapshot against, and a one-flat-set grant
that never rounds up. It derives the credential from the rule rather than the
person. A member whose access spans policies holds several credentials where
an AWS customer expects one. Minting requires a policy picker no S3 console
has. And the model does not survive a role change: a demoted member's
policy-minted keys are exactly as wrong as anyone else's, so member-level
re-sync is needed anyway, and once it exists the policy tie adds a second
divergence axis without adding control.

**Caller-chosen key permissions**, the shipped model, lets a customer mint a
deliberately narrow key, a read-only credential for one app. It attaches
permissions to credentials instead of people: the console matrix is advisory
until a creation-time cap patches it (M1's `checkCreatorAuthority`), nothing
can say what a key should become when its holder's access changes, and the
narrow-key use case is better served by a principal whose access is itself
narrow (Open questions).

**Policies as console data above the interface**, with the orchestrator taking
a pre-resolved grant on each key call, keeps the M2 interface a few lines long
and gives every policy mutation `commitAudited`'s one-transaction guarantee
directly. It also leaves the approximation in the console permanently. The
policy store exists only to imitate what a real IAM backend does natively, and
holding it above the interface means M3 must push the console's policy state
into the system enforcing it, a sync channel that can drift, while the
enforcing system never owns the rules it enforces. Behind the interface, the
store is an
implementation detail three regions share and one region retires, and M3 is a
swap instead of a migration
([§10](#10-the-service-orchestrator-interface)).

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
   deleted name.** Forge already filters enumeration, so those are the two
   facts left to measure, both against Forge unchanged. Being ours, an unwanted
   answer there is a bug to fix, which makes it the cheapest of the three to
   settle.
3. **Whether FIL-1017's ListBuckets criterion stands as written.** The ticket
   asks for out-of-scope buckets to be absent from `ListBuckets` on a member's
   keys, which Aurora and Forge deliver and FTH does not
   ([§4](#4-access-keys-belong-to-a-member)). Since the output is names a member
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
   `ListBuckets` question in [§4](#4-access-keys-belong-to-a-member), so both
   asks should travel together.
5. **What answers the narrow service credential?** Today a customer mints a key
   holding less than they do, such as a read-only credential for one app. A
   member-derived key carries the member's whole access, so that use case loses
   its current home. AWS's answer is an IAM user per workload; the PRD rules
   service accounts out of scope. Whether a later milestone revives them as
   machine members on policy rosters is an open product question, and nothing
   here blocks it.
6. **Whether a policy should carry a prefix rather than a whole bucket.** A
   policy is the natural place to put one, since it already names a region and a
   permission set, and the key's `buckets` array cannot express it. Prefix scope
   is Tier 3 work and belongs to the Forge enforcement story (FIL-1018), and
   nothing here blocks it; with policies behind the interface, it can even ship
   as a Forge-only capability the per-region matrix discloses.
7. **What a partially failed cross-region re-sync leaves behind.** An
   org-level change re-syncs keys on every provisioned orchestrator
   ([§7](#7-policy-lifecycle)); a vendor failing mid-pass leaves one region
   revoked and another divergent. Re-driving is idempotent, since
   `deleteAccessKey` treats an already-deleted key as success, so the answer
   is probably a retry surface, and the flow that owns it is unwritten.

## References

- Tickets: FIL-1017 member bucket scope, FIL-1018 revocation timing at vendors
  and prefix enforcement, FIL-1019 privileged operations (the bucket-lifecycle
  half is decided here), FIL-1020 legacy key transition, FIL-1021 key review
  on scope change and member removal, FIL-1022 audit viewer, FIL-1024
  per-region disclosure, FIL-1025 M3 direct-key enforcement, FIL-918 Forge
  key update, FIL-949 request-level logging.
- [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md) for
  roles, the permission registry, the audit write path, and the backfill sequence
  this design follows.
- Staging measurement, 2026-08-26: `ListBuckets` conformance per region
  ([§4](#4-access-keys-belong-to-a-member)).
- **The tier split source is missing.** Four M2 tickets cite a "2026-08-11
  enforcement analysis", which the M1 ADR names
  `iam-prd-enforceability-by-backend.md` in the knowledge-base repo. That repo
  holds 61 files at HEAD and none of them is it. The Tier 2 and Tier 3 vocabulary
  it defines sorts work across FIL-1017 through FIL-1024, so someone should find
  it or write it again. This design does not wait on it: §4 and §6 measured the
  backend behavior the tier split was there to decide.
