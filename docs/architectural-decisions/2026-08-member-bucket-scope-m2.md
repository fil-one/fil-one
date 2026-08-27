# Member bucket scope (IAM M2, FIL-1017)

**Status:** Draft (design exploration, awaiting acceptance)
**Created:** 2026-08-26
**Builds on:** [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md)

## Context

An Owner or Admin gives a member access to a subset of the tenant's buckets, or
to all of them, and a member holding a grant to a subset sees and interacts with
only that set. Console API routes therefore return results for that set alone and
the console renders what it gets. Scope here is whole buckets; a prefix inside a
bucket is a later milestone.

**A bucket can be deleted and replaced without FilOne learning.** On
`us-east-1` a customer's own access key deletes a bucket and nothing in the
product records it.
The Management API has no event or audit surface, an S3 `ListBuckets` returns a
name and a creation date, and no contract exposes which key acted. The same
region lets a deleted bucket name be claimed again, measured on staging on
2026-08-26 (`bin/bucket-name-reuse-probe.ts`). A credential can therefore delete
a bucket unobserved and recreate the name, leaving a listing that shows the
replacement as an original. Every tenant carries that exposure, whether or not
any of its members are scoped, and closing it puts a FilOne handler on every
bucket creation and deletion ([§4](#4-bucket-lifecycle-moves-to-the-console)).

**FilOne stores no bucket records.** A bucket exists at the orchestrator and
nowhere else: `list-buckets.ts` fans out across provisioned regions and merges
what answers, and `get-bucket.ts` calls one orchestrator. A grant therefore names
a bucket FilOne cannot validate locally, and it can outlive the bucket it names.
What a bucket does have is a stable identity of `(region, bucketName)`. Every
bucket-addressed route carries a region (`get-bucket.ts:30` defaults to
`S3_REGION`), `BucketSummary` carries one, and the RAG tables already key on
`BUCKET#{orgId}#{region}#{bucketName}` (`lib/dynamo-records.ts`). S3 bucket names
contain no `/`, so `{region}/{bucketName}` composes into a key unambiguously.

The caller's authorization state already arrives on the request, since M1 hands
handlers the membership row itself on `userInfo.membership`
(`lib/user-context.ts`). Key issuance already takes a bucket list too:
`IssueAccessKeyOpts.buckets` is honored by all three orchestrators
(`fth-orchestrator.ts:228`, `aurora-orchestrator.ts:199`,
`orchestrator/orchestrator.ts:314`), and the create-key request carries
`bucketScope: 'all' | 'specific'` with a `buckets` array
(`packages/shared/src/api/access-keys.ts:159`).

Enforcement has to live in the console API, because the console signs object
operations with one tenant-wide credential. `presign.ts` calls
`orchestrator.getS3ClientContext(tenantId)`, which resolves the per-tenant
`filone-console` key from SSM (`lib/s3-credentials.ts`), and that credential
addresses every bucket the tenant owns. Whatever the console refuses to sign is
the whole of the enforcement.

## Decision

1. **Bucket scope is enforced in the console API.** A handler refuses a request
   that names an out-of-scope bucket, and results returned by orchestrators
   (bucket list, bucket activity) are filtered against the caller's granted scope
   on every request. The tenant-wide console credential and the SigV4 keys
   already issued are not narrowed, which is M3's work.
2. **Member bucket grants get their own table**, continuing the practice M1
   introduced of splitting records into separate tables where the access pattern
   allows.
3. **One row per bucket grant**, instead of an entry in a list held as a property
   of one record.
4. **Bucket scope is not enforced on org-wide aggregates.** Usage, billing, and
   dashboard counts stay org-wide.
5. **A scoped member who creates a bucket is granted it in the same request.**
   Every other member's scope changes only when an Owner or Admin says so.
6. **Enumeration over S3 is filtered by the key's bucket list, in every region.**
   A key whose `buckets` array is non-empty lists only those buckets. The
   Management API spec is where that gets written, and a gateway that does not do
   it is not conforming ([§5](#5-access-keys-the-cap-and-enumeration)).
7. **`CreateBucket` and `DeleteBucket` come off customer access keys**, in every
   region, until an orchestrator can report a bucket's lifecycle and the key that
   changed it (FIL-1019). Every bucket's creation and deletion then runs through a
   FilOne handler. That handler writes the auto-grant, runs the name-reuse sweep,
   and appends the `bucket.created` and `bucket.deleted` events.

### 1. Data model

Grants live in a new `BucketAccessTable`, declared in `sst.config.ts` beside the
existing tables. One attribute joins the membership row in `OrgTable`.

| Table               | pk                                         | sk                      | Attributes               | Purpose                                      |
| ------------------- | ------------------------------------------ | ----------------------- | ------------------------ | -------------------------------------------- |
| `BucketAccessTable` | `ORG#{orgId}#MEMBER#{userId}`              | `{region}/{bucketName}` | `grantedBy`, `grantedAt` | the grant; a member's scope is one partition |
| `BucketAccessTable` | `ORG#{orgId}#BUCKET#{region}/{bucketName}` | `MEMBER#{userId}`       | `grantedBy`, `grantedAt` | inverse: who can see this bucket             |
| `OrgTable`          | `ORG#{orgId}`                              | `MEMBER#{userId}`       | `bucketScope`            | whether the grants apply                     |

`bucketScope` names two things in this product. On a membership row it is the
**member scope**, the set of buckets a person reaches in the console; on an
access-key row it is the **key scope**, the set a credential may operate on
(`ACCESS_KEY_BUCKET_SCOPES`). Both take the values `'all'` and `'specific'`, and
[§5](#5-access-keys-the-cap-and-enumeration) caps the second against the first.

One row per grant means grants never collide: two admins granting different
buckets to the same member write different rows, so nothing is
read-modify-written and a grant costs one write. Both rows go in one
`TransactWriteItems`, on grant and on revoke, the way M1 keeps membership and its
inverse item consistent, and the grant reads carry `ConsistentRead` for the
reason `org-membership.ts` gives for the role read: an access-control read must
not see a stale replica.

Keeping `bucketScope` on the membership row is what makes the common case free.
Zero grant rows is ambiguous between "unscoped" and "scoped to nothing", and
resolving that from the grant table would put a Query on every request just to
learn that most callers are unscoped. `authMiddleware` already reads the
membership row, so `bucketScope: 'all'` answers with no I/O at all, and only a
scoped caller on a bucket-addressed route reads the grant table. `'specific'`
with no grant rows is a member who can see no bucket, and it fails closed.
Evaluating `'all'` per request also means a bucket created after the marker was
written is inside the scope by definition.

Grants get their own table because they are unbounded per member. In `OrgTable`
they would share the `ORG#{orgId}` partition with the membership, invitation, and
`META` rows that every authenticated request already reads, concentrating a
growing row count on the hottest partition in the product.

During rollout, a membership row carrying no `bucketScope` means `'all'`, since
every row written before this work carries no marker and today every member sees
every bucket. The backfill stamps `'all'` on every row and the following PR
removes the fallback, the sequence M1 used for the role fallback
([`2026-08-organizations-roles-m1.md` §2](./2026-08-organizations-roles-m1.md#2-roles-and-the-permission-registry)).

### 2. Resolving a scope on a request

The resolver is a lib module in the shape M1's `lib/key-scope.ts` takes for the
same problem one level up, except that this one does I/O:

```ts
export type BucketScope = { sees: 'all' } | { sees: 'specific'; orgId: string; userId: string };
```

Owner and Admin are unscoped by role, a caller whose membership row says `'all'`
is unscoped, and everyone else is `specific`. An unscoped caller's grant rows are
never read, on any route, because the role and the marker settle the answer
before the table is reached. Nobody deletes them either, since widening a scope
and promoting a member out of one both leave the rows in place
([§6](#6-lifecycle)).

`GET /api/buckets` and `GET /api/activity` then issue one Query on the member's
partition and filter the merged fan-out result against it, walking every page,
since a scope that truncates silently hides buckets a member was granted. Every
bucket-addressed route issues one `GetItem` on the exact grant key: no Query, no
list, O(1) per request. The check runs in the handler, not in middleware, because
`authorize()` decides from the route manifest alone and the manifest cannot name
a bucket, while the bucket arrives in a path parameter or, for
`POST /api/presign`, in each element of the body.

| Route                                         | Scoped behavior                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/buckets`                            | filter the merged fan-out result to the granted set                                                        |
| `POST /api/buckets`                           | allowed; the new bucket is granted to the creator ([§4](#4-bucket-lifecycle-moves-to-the-console))   |
| `GET /api/buckets/{name}`                     | no grant row gives the same 404 a missing bucket gives                                                     |
| `DELETE /api/buckets/{name}`                  | gated on `buckets.delete`, which only an unscoped caller holds                                             |
| `GET /api/buckets/{name}/analytics`           | 404                                                                                                        |
| `GET \| POST /api/buckets/{name}/rag/enabled` | 404                                                                                                        |
| `POST /api/buckets/{name}/bulk-delete`        | 404                                                                                                        |
| `GET /api/bulk-delete-jobs/{jobId}`           | the job row names its bucket; check that bucket, 404 otherwise                                             |
| `GET /api/activity`                           | filter the bucket entries to the granted set                                                               |
| `POST /api/presign`                           | check every operation's bucket; one denial refuses the batch                                               |
| `POST /api/buckets/{name}/query` (bearer)     | the bearer branch resolves the key creator's membership row, so that member's current scope applies        |
| `POST /api/access-keys`                       | requested key scope is capped at the creator's member scope ([§5](#5-access-keys-the-cap-and-enumeration)) |
| `POST /api/rag-api-keys`                      | same cap                                                                                                   |
| `POST /api/org/invitations`                   | carries the invited member's scope, materialized on accept ([§6](#6-lifecycle))                            |
| `PATCH /api/org/members/{userId}`             | carries scope changes, and refuses a narrowing that strands keys ([§6](#6-lifecycle))                      |

The last two are M1 routes gaining a payload, and they keep the `members.manage`
requirement they already declare, which FIL-1017's "Owner or Admin assigns a
bucket scope" matches exactly.

An out-of-scope bucket answers exactly like a bucket that does not exist: same
status, same body, no new `ApiErrorCode`, since a distinct code would confirm the
bucket exists. That costs a worse message for a member whose access was revoked
while their tab was open, who gets "Bucket not found" where "your access was
removed" would be truthful. Hiding and explaining are exclusive here, and hiding
is what the feature is.

`POST /api/presign` refuses the whole batch on one denial, per M1's rule, and
since the batch carries one `region` query parameter covering every operation
(`presign.ts:155`) the handler checks that region against the distinct bucket
names in a single `BatchGetItem`. A queued bulk-delete job runs to completion,
because the job row carries no creator (`lib/bulk-delete-jobs.ts:90-100`) and
the worker drains its queue after the request returns, so revoking a grant stops
the member reading the job's status while their deletion finishes unannounced.

### 3. What a scoped member can still see

Decision 4 leaves the aggregates org-wide, so a scoped member can still learn
that other buckets exist. `GET /api/usage` and `/api/usage/trends` report
org-wide bytes and object counts, the dashboard's bucket count and key count are
org-wide totals, and `GET /api/billing` is org-wide by construction because the
subscription is the org's. Closing those means a per-bucket breakdown on each
aggregate, and then the numbers a scoped member sees stop matching the invoice.

Two smaller exposures stay because closing them costs more than they leak.
`HeadBucket` against an out-of-scope bucket answers 403 instead of 404 on both
measured backends, so a member who guesses an exact name confirms it exists, and
closing that would need the gateway to lie about existence. Presigned URLs
already issued stay valid until they expire, up to 7 days for downloads
(`handlers/presign.ts:40`), which is the real revocation bound for object reads
after a scope change. What a member's existing SigV4 keys reach is a separate
matter ([§5](#5-access-keys-the-cap-and-enumeration)).

The activity feed is scoped, because it names individual buckets.
`fetchBucketActivities` calls `orchestrator.listBuckets(tenantId)` in each
provisioned region and renders one `bucket.created` entry per bucket, carrying
the name (`handlers/get-activity.ts:136-166`), which hands every bucket name in
the org to every role. So the handler filters those entries against the same
grant Query `GET /api/buckets` runs. Key entries need no change, since M1 already
narrows them by `createdBy` under `keys.manage_own`.

### 4. Bucket lifecycle moves to the console

`create-bucket` writes the creator's grant rows **before** calling the
orchestrator and deletes them if creation fails. A grant naming a bucket that
does not exist grants nothing, so the pre-write is safe in a way the post-write
is not: a grant write that fails after a successful create leaves a member unable
to see the bucket they just made. The two steps cannot be one transaction,
because the bucket lives at the vendor, so what survives is a grant left behind
by a failed create, inert until someone creates a bucket of that name in that
region, and that someone is granted it anyway.

A deleted bucket name can be reused at the same orchestrator, and a stale grant
then applies to whatever new bucket takes the name. So bucket deletion has to run
through the console API, where `delete-bucket` removes that bucket's grants
through the inverse partition as part of the deletion. The sweep sits outside the
delete's own atomicity, so a grant it misses leaves a member seeing a bucket
nobody gave them.

Whether a name can be reused at all was measured on staging. On `eu-west-1` a
recreate answers HTTP 409, "This bucket name is already taken", so a stale grant
there is permanently inert. On `us-east-1` the recreate succeeds, so the grant
binds to the new bucket. `eu-central-3` is untested. Nothing in the Management
API spec requires either behavior, so both vendors could change their name policy
without breaking a promise, and the sweep therefore ships for every region
instead of being tuned per region.

Customer keys therefore stop carrying `CreateBucket` and `DeleteBucket` in every
region. The `filone-console` key keeps both actions, so the console's own bucket
lifecycle is untouched. What goes away is a customer credential creating or
deleting a bucket.

Bucket creation and deletion reach a different API surface at each Service
Orchestrator. On Aurora both operations are Portal API calls
(`createAuroraBucket` and `deleteAuroraBucket`, reached through
`createPortalClient`), so only FilOne can make them and the region has never had
the exposure. On FTH and Forge they are S3 data-plane operations: the console
performs them with the tenant's `filone-console` credential, and a user key
carrying `s3:CreateBucket` or `s3:DeleteBucket` performs the identical operation
without FilOne seeing it. Aurora is built this way today, so FTH and Forge would
be matching a shipped region. It also makes every region behave the same way,
which is one answer to FIL-1024's question of whether capabilities should differ
by region at all.

The change is small and reversible. `BUCKET_PERMISSIONS`
(`packages/shared/src/api/access-keys.ts`) stops being offered,
`CreateAccessKeySchema` refuses the two values, the console drops the two
checkboxes, and `supportsBucketManagement` is deleted with its callers, having
nothing left to gate. Re-enabling is the same edit backwards, with no migration
either way. A denied attempt answers with the vendor's `AccessDenied`. That is
the S3 error FIL-1019's acceptance criteria ask for.

Customers scripting bucket lifecycle against the S3 API lose that capability.
The product ships it today in the FTH and Forge regions. The Console API is
session-authenticated, so no credential FilOne issues reaches `POST /api/buckets`
either, and scripted bucket lifecycle has no supported path until an orchestrator
reports lifecycle events and the permission can return. Keys already carrying the
two permissions keep them until FIL-1020 retires them, so a bucket deleted with
one of those still leaves its grants behind. The console labels the two
permissions as legacy on the keys that hold them, which gives FIL-1021's key
review something to act on.

With every create and delete passing through a handler, `bucket.created` and
`bucket.deleted` become writable for the first time. Each carries the acting
user, the region, the bucket name, and the timestamp. Neither records the grants
swept with the bucket, since the `member.scope_changed` event that granted them
already names them.

### 5. Access keys: the cap and enumeration

The key's `buckets` array is the only bucket-scoping primitive the orchestrator
APIs expose. It is `CreateAccessKeyRequest.buckets` in the Management API
contract, the same field on Aurora's portal API, and the same on FTH; there is no
bucket ACL, no per-user bucket ownership, and no ListBuckets filter in any of the
three. One array therefore carries both jobs below.

**The cap.** A scoped creator names buckets from their own grants in the key's
region. M1 capped a new key's _permissions_ at the creator's console permissions
and deferred the bucket half here. A key belongs to one region
and its `buckets` array holds bare names, so the handler filters the creator's
grants to that region and requires every requested name to appear. A creator
whose member scope is `all` is unaffected. A member scoped across three
regions mints three keys to cover their scope, and cannot request
`bucketScope: 'all'` even if the console sends it, because materializing `'all'`
into their current grants would mint the same key while hiding what it
reaches.

Every key is a snapshot of the scope at minting, so widening a member's scope
leaves their existing keys alone and reaching a newly granted bucket means
minting a new one, which the console says at creation and again when an Owner or
Admin widens somebody's scope. That comes from the backends: Aurora's keys are
immutable and FTH has no key-update endpoint, so changing what a key reaches
means revoking it and issuing another under a new access key ID. Forge gets out
of that once FIL-918 lands, where a key narrows in place, leaving one console
flow with two regional outcomes (FIL-1017) for FIL-1024's per-region matrix to
show.

**Enumeration.** `aws s3 ls` reaches the storage gateway directly and never
touches a FilOne handler, so the route table above does nothing for it. Every key
FilOne mints carries `s3:ListAllMyBuckets` unconditionally
(`ALWAYS_PERMISSIONS`, `orchestrator/orchestrator.ts:497`;
`FTH_ALWAYS_PERMISSIONS`, `fth-orchestrator.ts:377`), Aurora grants it inside its
default permissions, and the console renders it as a checked, disabled checkbox
(`docs/S3Considerations.md`), so a scoped member holding any key can enumerate
every bucket in the org.

Decision 6 answers that by carrying the rule that already governs the key's
object operations to the one operation the gateway answers without asking us: a
key whose `buckets` array is non-empty lists only those buckets, and an empty
array is tenant-wide. The Management API spec is where it gets written, since
`CreateAccessKeyRequest.buckets` promises only that the key "may only operate on
these buckets" and says nothing about what the key lists. FIL-1017 asks for
out-of-scope buckets to be "absent from console and from ListBuckets on that
member's keys", so filtered enumeration is a stated acceptance criterion, which
leaves one mechanism and a conformance question per region. Aurora and FTH were
measured on staging (2026-08-26):

| Region                 | Refuses an out-of-scope object read | Lists only the key's buckets   |
| ---------------------- | ----------------------------------- | ------------------------------ |
| `eu-west-1` (Aurora)   | yes                                 | yes                            |
| `us-east-1` (FTH)      | yes                                 | no, the whole tenant came back |
| `eu-central-3` (Forge) | untested                            | yes                            |

A scoped key reading a bucket it does not name is refused on both measured
backends, which is the column this design rests on. Enumeration is the smaller
problem. Aurora conforms today, so a scoped member's `aws s3 ls` there shows
exactly their buckets with nothing built on our side. FTH does not, and the fix
is a change request carrying the contract sentence, sent in the message that
carries the lifecycle-feed ask from
[§4](#4-bucket-lifecycle-moves-to-the-console). Until it lands, a scoped member on
`us-east-1` holding any key can list every bucket name in the org, and what
leaks is the names alone: that member cannot read, write or delete an object in
a bucket their key does not name, and the console shows them nothing outside
their scope. This design discloses the gap as an accepted cost and builds
nothing region-specific while it stands. Forge already lists only the key's
buckets, so FTH is the one region outstanding. Whether Forge also refuses an
out-of-scope object read is unmeasured, and being ours an unwanted answer there
is a bug to fix; M3's direct-key enforcement (FIL-1025, on FIL-918) is where the
gateway reads a key's scope from the system enforcing it.

A key minted before scope existed carries no bucket list, so the rule reads it
as tenant-wide and it keeps enumerating everything after every region conforms,
which is the legacy transition (FIL-1020) and the reason scoping a member should
prompt a review of the keys they already hold (FIL-1021). `CreateBucket` outside
the key's list stops being reachable at all once customer keys lose
`s3:CreateBucket`.

### 6. Lifecycle

**Invite.** A scope is assigned at invite and edited afterwards (FIL-1017). At
invite time there is no `userId` to key a grant row on, so the invitation row
carries the intended scope inline: `bucketScope` plus a list of
`{region}/{bucketName}` entries on the row M1 already writes at `ORG#{orgId}` /
`INVITE#{inviteId}`. A list is right here for the reason it was wrong on the
membership row ([Options considered](#options-considered)), since the invitation
is written once, read once on accept, expires in 14 days, and never sits on a
request path. An arbitrary number of grant rows cannot join M1's accept
transaction against the 100-item limit, so acceptance lands the membership first
with its `bucketScope` marker and the grants follow. That order makes the failure
safe: a member whose marker says `'specific'` and whose grants have not been
written yet sees no bucket, and the invitation row survives acceptance, so the
scope it names is still there to re-drive. An Owner or Admin invitation carries
no scope at all.

**Narrowing.** Revoking a grant deletes both rows in one transaction, binds on
the next request, and takes the member's non-conforming keys with it, since those
keys may still name the bucket and FIL-1017 asks for no silent narrowing and no
silent survival. `PATCH /api/org/members/{userId}` computes those keys
server-side and refuses the change without an explicit confirmation, answering
with the list; once the admin confirms, one flow revokes the keys and then writes
the scope. Revocation is a vendor call, so the two steps
cannot be one transaction, and that order is what keeps a partial failure safe: a
failed revoke leaves the member where the operation started, while writing the
scope first would narrow them in the console while their key still reaches the
dropped bucket at the gateway. Re-driving is safe as long as deleting an
already-deleted key counts as success.

Finding the non-conforming keys is a local read, since both key kinds record
`createdBy` and their own `bucketScope` and `buckets`
(`packages/shared/src/api/access-keys.ts`, `lib/rag-api-keys.ts`). How fast a
revocation binds at the provider is what FIL-1018 is still asking vendors; this
document publishes no number for it, and the console's own cached bucket list
survives until the next refetch.

Keys minted before M1 have no owner and never will, so the confirmation dialog
cannot list them, and that unlistable cohort is the one a scope review most
wants. The dialog therefore carries the org's unattributed key count beside the
named list, so an Admin reads "3 keys will be revoked, 7 keys in this org have no
recorded owner and are not checked" instead of a list that looks complete.
Labelling those keys and restricting them to Owners and Admins is FIL-1020.

**Demotion** out of an unscoped role runs the same flow, because demoting an
Admin to Member activates whatever scope that person retained while the keys they
minted hold `bucketScope: 'all'`. That is a narrowing under any reading of
FIL-1017. Owner to Admin never triggers it, and neither does a demotion into a
retained scope of `'all'`.

**Promotion** leaves everything in place: `bucketScope` and every grant row stay
as they are, and the new role means nothing reads them. Enforcing a scope
against an Admin would protect nothing anyway, since an Admin holds
`members.manage` and can edit their own scope in one request. Retention is what
lets a later demotion reuse the old scope: the editor opens with the member's
retained grants already selected, rendered as inactive until the change lands.

**The scope editor sends deltas, never a replacement set.** The picker is
populated from the admin's own unscoped `ListBuckets`, which can omit a granted
bucket when a sweep was missed or when a region is down and reported in
`unavailableRegions` while returning nothing (`list-buckets.ts:57-64`). If saving
deleted every grant not ticked, one save during a `us-east-1` outage would revoke
that member's whole `us-east-1` scope in silence. So the request names the
buckets granted and the buckets revoked, and the handler writes those. An
unavailable region renders as a disabled section reading "unavailable, N grants
unchanged", and a grant whose bucket is gone from a healthy region renders as a
stale entry with a clear action. An empty scope saves, since suspending someone's
access without removing them from the org is a real thing to want.

**Removing a member** leaves grants behind, since they are unbounded and cannot
join the transaction that deletes the membership and its inverse item, so a sweep
follows it. An orphaned grant grants nothing on its own, because `authorize()`
refuses a caller with no membership row, but it would revive if that user
rejoined the org, and `deletion-scrub.ts` learns the new table so a missed sweep
is still collected. Member removal revokes keys through FIL-1021's flow instead
of this one's. **Deleting an org** reaches the new table through the members it
already enumerates.

### 7. Audit events

M1 shipped the audit write path and closed its event list at
`member.role_changed` and `member.removed`. FIL-1022's first acceptance criterion
asks for membership changes including scope, so this feature adds the events
while FIL-1022's ADR owns the viewer, the retention, and the export.

Each admin action writes one event. `member.scope_changed` carries the marker
before and after, the granted and revoked bucket keys, and the ids of any keys
revoked with it, where a per-bucket `bucket.granted` would flood the FIL-1022
viewer with a row per checkbox and multiply the items in a transaction already
bounded at 100. `member.invited` and `invite.accepted` gain the scope, and
`bucket.created` and `bucket.deleted` are defined in
[§4](#4-bucket-lifecycle-moves-to-the-console).

The event joins the `TransactWriteItems` that writes the `bucketScope` marker,
the way M1's `commitAudited` handles a pure-DynamoDB mutation, and the grant rows
follow outside it for the transaction-limit reason [§6](#6-lifecycle) gives. The
narrowing flow calls a vendor before writing anything local, so it takes M1's
intent-and-completion pattern instead, and a crash between the two leaves a
visible dangling intent instead of revoked keys with no record.

Denials are not logged. A scoped member hitting an out-of-scope bucket gets a
404, and one event per 404 turns the audit log into a traffic log. FIL-1022
scopes itself to control-plane events, and request-level logging is FIL-949.

### 8. Rollout

The M1 sequence applies unchanged: ship the table and the write path, backfill
`bucketScope: 'all'` onto every membership row under `sst shell` with a dry run
and a verify pass, confirm the stamp, then ship enforcement with the
absent-means-all fallback removed. Until an Owner or Admin scopes somebody,
nothing observable changes, which is what lets the enforcement PR merge
independently.

The table ships with point-in-time recovery, the way `OrgTable` did, and with an
IAM grant narrowed to the operations the handlers perform instead of the shared
`allResources` link. The account-deletion teardown and `deletion-scrub.ts` are
wired to it in the same PR that creates it, before any row exists.

The console surface is a scope editor on the members page (the per-region picker
with the delta and unavailable-region behavior in [§6](#6-lifecycle)) and an
access list on the bucket detail page, fed by the inverse partition. Both sit
behind the `ORGS_BETA` row pattern (`lib/orgs-beta.ts`), where granting is a row
instead of a redeploy.

## Options considered

**Reconciling grants against `ListBuckets` on read**, instead of removing the two
permissions, would leave customer bucket lifecycle where it is and repair the
grant table from what the orchestrator reports. Nothing available supports it. A
grant naming a bucket that no longer exists is already inert, so the failure that
reconciliation has to catch is the reused name, which means telling an original
bucket from a recreation. No orchestrator exposes a stable bucket identity:
`BucketSummary` carries a name and a creation date, and a delete followed by a
recreate inside the polling interval defeats both. Reconciliation becomes
possible on the day a lifecycle feed exists, and that is the same day the
permission can return.

**A String Set on the membership row** (`buckets`, holding the same
`{region}/{bucketName}` entries) needs no new table and no read at all, since the
scope arrives on the row `authMiddleware` has already fetched. `ADD` and `DELETE`
are atomic, so grants still do not collide, and it caps one member at roughly
14,000 entries against the 400KB item limit, which no tenant approaches. But the
row is read on **every** authenticated request at 1 RCU per 4KB, so a member
scoped to a thousand buckets makes ~28KB, or 7 RCU, of every request in the
product, including the routes that never touch a bucket. The ceiling is
comfortable and the hot-path cost is what rules it out.

**Withholding `s3:ListAllMyBuckets` from a scoped member's keys** refuses
enumeration whatever the gateway does, and it costs the command outright:
`aws s3 ls` answers `AccessDenied` and breaks tooling that enumerates before it
acts. It is also not generally available. On Aurora the action rides inside the
`Default` grant, so withholding it drops `s3:GetBucketLocation` with it and
`ListBuckets` is answered anyway; on FTH, omitting it turns `ListBuckets` into
`AccessDenied` and changes nothing else. That is a workaround shaped to one
vendor, bought with a conditional branch in a permission set that has none today.
Existence probing by name survives decision 6 and is accepted rather than solved
([§3](#3-what-a-scoped-member-can-still-see)).

**A per-member FTH storage user** comes closest to a second scoping primitive,
since keys are minted under one and FilOne creates a single `filone-console` user
per tenant. A storage user carries no bucket scope of its own (`FthStorageUser`),
the generic Management API has no equivalent concept, and Aurora exposes none, so
a per-member user would buy attribution instead of filtering.

## Open questions

1. **Does console-mediated enforcement end on Aurora and FTH?** Decision 1
   accepts that `filone-console` addresses every bucket in the tenant. M3 is
   direct-key enforcement on Forge (FIL-1025, on FIL-918), which leaves the other
   regions where [§2](#2-resolving-a-scope-on-a-request) puts them unless a
   vendor answers. Whether they ever reach parity is the "parity vs Forge-first"
   decision the M3 milestone is gated on, and it decides whether any of §2 is
   temporary.
2. **What Forge does with an out-of-scope object read and with a reused name.**
   Forge already filters enumeration, so what is left is the object-read column
   ([§5](#5-access-keys-the-cap-and-enumeration)) and the name-reuse run
   ([§4](#4-bucket-lifecycle-moves-to-the-console)), both against Forge
   unchanged. Being ours, an unwanted answer there is a bug to fix, which makes
   it the cheapest of the three to settle.
3. **Whether FTH will filter `ListBuckets` by the key's bucket list.** The one
   open dependency in [§5](#5-access-keys-the-cap-and-enumeration). It needs an
   owner for the FTH relationship rather than an engineering decision, since
   nothing is built here either way: what is needed is the spec sentence accepted
   and implemented, and what would settle it is a date.
4. **What returns bucket lifecycle to customer keys.** A feed carrying bucket
   creations and deletions, with the acting access key identified, on the two
   Service Orchestrators that need one. On Forge that is the same
   [Hilt](https://github.com/fil-forge/hilt) work the rest of M3 needs (FIL-918's
   permission read-back); on FTH it is a vendor ask. Aurora needs nothing, having
   never had the exposure. The feed alone would let grants be reconciled
   ([Options considered](#options-considered)); the acting key is what answers the
   unobserved deletion, and only both together put `CreateBucket` and
   `DeleteBucket` back on a customer key. The same message closes the
   `ListBuckets` question in [§5](#5-access-keys-the-cap-and-enumeration), so both
   asks should travel together.
5. **Does a RAG API key's own bucket list bind on a bearer query?** The bearer
   branch resolves the creator's membership, so their current scope applies
   ([§2](#2-resolving-a-scope-on-a-request)), and the key row also records the
   scope it was minted with. Whether the query is checked against the
   intersection or against the creator's live scope alone is unstated, and the
   two differ once the creator's scope widens after the key was minted.

## References

- Tickets: FIL-1017 member bucket scope, FIL-1018 revocation timing at vendors,
  FIL-1019 privileged operations (the bucket-lifecycle half is decided here),
  FIL-1020 legacy key transition, FIL-1021 key review on scope change,
  FIL-1022 audit viewer, FIL-1024 per-region disclosure,
  FIL-1025 M3 direct-key enforcement, FIL-918 Forge key update, FIL-949
  request-level logging.
- [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md) for
  roles, the permission registry, the audit write path, and the backfill sequence
  this design follows.
- Staging measurements, 2026-08-26: bucket-name reuse per region
  ([§4](#4-bucket-lifecycle-moves-to-the-console)) and `ListBuckets`
  conformance per region ([§5](#5-access-keys-the-cap-and-enumeration)).
- **The tier split source is missing.** Four M2 tickets cite a "2026-08-11
  enforcement analysis", which the M1 ADR names
  `iam-prd-enforceability-by-backend.md` in the knowledge-base repo. That repo
  holds 61 files at HEAD and none of them is it. The Tier 2 and Tier 3 vocabulary
  it defines sorts work across FIL-1017 through FIL-1024, so someone should find
  it or write it again. This design does not wait on it: §4 and §5 measured the
  backend behavior the tier split was there to decide.
