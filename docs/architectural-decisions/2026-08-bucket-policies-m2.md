# Bucket access by region: scoped keys on Aurora and FTH, IAM on Forge (IAM M2, FIL-1017)

**Status:** Draft (design exploration, awaiting acceptance)
**Created:** 2026-08-26
**Builds on:**
[`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md)

## Context

Where FilOne controls the stack, the console works like AWS. Where it does not,
the console keeps the scoped-key model it ships today, capped by the member's
role, and tells the user when a role change forces a key revocation.

FIL-1017 asks that an Owner or Admin can give a member access to a subset of
the org's buckets, and that a member holding a subset sees and acts on that set
alone. M1 made membership and roles real at the control plane and capped a new
key at its creator's authority; it left bucket scope to this milestone. Access
here is whole buckets; a prefix inside a bucket is later work (FIL-1018).

The three storage backends do not model access the same way. Aurora
(`eu-west-1`) and FTH (`us-east-1`) model an org as a tenant and an access key
as a credential with its own permission set and bucket list, fixed at creation.
Neither can change what a key carries after it is minted, and neither accepts
a policy document. Aurora has no user object; FTH keys hang off a storage user
(`packages/backend/src/lib/fth/fth-tenant-setup.ts:106-114`) that carries no
permission set of its own, so it is not a principal a key's authority derives
from, and the key keeps its own permission set
(`packages/backend/src/lib/fth/fth-orchestrator.ts:449-452`).
`IssueAccessKeyOpts` (`packages/backend/src/lib/service-orchestrator.ts:66-72`)
is that shape: a name, a permission list, an optional bucket list, and an
expiry. The key's `buckets` array is the only bucket-scoping primitive either
vendor exposes.

AWS models users and roles. An access key belongs to an IAM user and carries
nothing of its own: what it can do is what its user may do, evaluated at request
time, so a change to the user reaches every key the user holds without reissuing
any of them. Bucket policies grant bucket-level access to users and groups.

Forge is the backend FilOne controls. Its management API, Hilt, models tenants
and flat-permission keys today, the same shape as the vendors, and it can be
extended to model principals and policies because it is ours
([§11](#11-the-iam-contract-for-forge)).

Two designs that put one product over the three backends both fell short: one
tied a credential to a rule instead of a person, the other handed a vendor key
more than the member holds and reissued it on every narrowing
([Options considered](#options-considered)).

The decision, taken 2026-09-01, is to stop masking the difference. This is the
"lead where we control the stack" path of the enforceability memo
(`iam-prd-enforceability-by-backend.md`, 2026-08-11), which sorted the PRD's
requirements by what each backend can enforce.

**Vocabulary.**

- The **scoped-key model** is Aurora and FTH. The org is a tenant; an access
  key carries its own permission set and bucket list, fixed at creation; the
  member's role caps what a key may carry.
- The **IAM model** is Forge, once its Hilt network implements the contract in
  [§11](#11-the-iam-contract-for-forge). Each org member is a principal at the
  storage system with a permission ceiling; bucket policies grant bucket-level
  access; an access key belongs to a member and its authority is the member's.
- A **bucket policy** is a named rule over one region, a bucket set in that
  region (a list of bucket names, or every bucket in the region present and
  future), a permission set, and a roster of org members. It exists only in the
  IAM model.
- An **unscoped member** is an Owner or Admin. They reach every bucket by role
  in both models. In the IAM model, a Member or ReadOnly member reaches a Forge
  bucket only through a policy.

**What exists in code today**, at `origin/main` (`0f63b5bd`):

- Four regions. `eu-west-1` and `us-east-1` are generally available;
  `eu-central-3` and `us-east-9` are Forge regions offered on non-production
  stages only (`packages/shared/src/constants.ts:10-20`, `:73-79`). Forge runs
  as independent networks, each with its own Hilt serving every region in that
  network: staging Hilt for `eu-central-3` and the dev sandbox Hilt for
  `us-east-9`; production will have one network and has none today
  (`packages/backend/src/lib/forge/forge-orchestrator.ts:1-8`;
  `service-orchestrator-registry.ts:28-49`; `sst.config.ts:63-68`,
  `:655-661`). The Forge integration issues flat-permission keys with a bucket
  array through the Management API, the scoped-key shape
  (`packages/backend/src/lib/orchestrator/orchestrator.ts:314-334`).
- Key creation is capped at the creator's authority. `checkCreatorAuthority`
  (`packages/backend/src/handlers/create-access-key.ts:207-222`) refuses any
  requested permission the creator's role does not grant, through
  `ACCESS_KEY_PERMISSION_REQUIREMENT` and `GRANULAR_PERMISSION_REQUIREMENT`
  (`packages/shared/src/access-key-permissions.ts:27-36`, `:62-71`), and the
  form offers only the rows those tables allow
  (`packages/website/src/components/AccessKeyPermissionsFields.tsx:62-66`).
- A role change touches no key. `PATCH /api/org/members/{userId}` is one
  transaction over the membership rows, the owner counter, the pending
  invitations, and the audit event
  (`packages/backend/src/handlers/update-member-role.ts:96-113`). Removal is
  the same: "Keys are untouched in M1"
  (`packages/backend/src/handlers/remove-member.ts:64-66`), and the removal
  dialog says so (`packages/website/src/pages/MembersPage.tsx:408`).
- The console signs its own S3 traffic with one tenant-wide credential per
  region, resolved from SSM (`packages/backend/src/lib/s3-credentials.ts`): the
  `filone-console` key on Aurora and Forge, `filone-console-v2` on FTH
  (`service-orchestrator.ts:131-134`). On Forge that key is minted at tenant
  setup with every action in the contract enum and an empty bucket list
  (`packages/backend/src/lib/orchestrator/tenant-setup.ts:31-55`, `:201-211`).
- No persistent in-console notification exists, and the two SendGrid senders
  share no mailer (`packages/backend/src/lib/invite-mailer.ts:235-252`;
  `packages/backend/src/lib/deletion-email.ts:10-69`). No email is sent on a
  role change, a removal, or a key event.

## Decision

1. **Two access models, declared per orchestrator.** Aurora and FTH declare
   `'scoped-keys'`. A Forge region declares `'iam'` once the Hilt network
   serving it implements the contract; until then it declares `'scoped-keys'`
   and behaves as Aurora and FTH do. The console branches once, on the model
   of the region in hand ([§1](#1-two-access-models-declared-per-orchestrator)).
2. **Bucket policies exist only in the IAM model.** No production region
   declares `'iam'` today, so nothing about bucket visibility changes on
   `eu-west-1` or `us-east-1`
   ([§1](#1-two-access-models-declared-per-orchestrator),
   [§3](#3-what-a-bucket-policy-is)).
3. **Policy state lives at the storage system.** The console stores no policy
   rows; on an IAM region a Member or ReadOnly member reaches no bucket until
   placed on a policy, and an all-buckets policy is how an admin unscopes one
   ([§3](#3-what-a-bucket-policy-is), [§4](#4-resolving-access-on-a-request)).
4. **In the IAM model an access key belongs to a member.** The principal is
   always the caller, the key's authority is the member's effective access as
   the storage system evaluates it, and the key id and secret survive every
   change but one, demotion to a role without `keys.create`
   ([§5](#5-access-keys-belong-to-a-member), [§2](#2-the-scoped-key-model)).
5. **In the scoped-key model keys stay as they are today.** The creator's role
   caps the permission set at creation and the bucket list is the creator's
   choice ([§2](#2-the-scoped-key-model)).
6. **A role narrowing revokes scoped-key-model keys the holder could no longer
   mint.** One test decides it, the admin sees the keys before confirming, the
   member is emailed, and removal revokes under the same pass. On an IAM region
   the one narrowing that deletes keys is demotion to a role without
   `keys.create`; every other narrowing there follows live
   ([§2](#2-the-scoped-key-model)).
7. **The orchestrator interface splits by model.** A discriminated union with
   a shared core and two access surfaces; the storage system knows principals,
   and the role name stays in the console
   ([§10](#10-the-orchestrator-interface)).
8. **Bucket lifecycle stays on keys as the role permits.** `CreateBucket` and
   `DeleteBucket` stay on the key form where the region supports them; in the
   IAM model an unscoped member's key holds them and a scoped member's never
   does ([§7](#7-bucket-lifecycle-stays-on-keys-as-the-role-permits)).
9. **Enumeration over S3 is a name listing everywhere.** FTH and Forge list
   the whole tenant on any key; Aurora filters; a name in a listing has never
   meant access ([§8](#8-what-a-member-can-still-see)).
10. **Org-wide aggregates stay org-wide.** Usage, billing, and dashboard counts
    are not scoped ([§8](#8-what-a-member-can-still-see)).
11. **Audit stays console-written.** A change that crosses the interface takes
    M1's intent-and-completion pair; `commitAudited` keeps the changes that
    touch no vendor ([§9](#9-audit-events)).
12. **RAG API keys already resolve the creator's live membership** and sit
    outside the revocation pass; on an IAM region their bucket refs are checked
    against the member's resolved access
    ([§5](#5-access-keys-belong-to-a-member)).

### 1. Two access models, declared per orchestrator

Each orchestrator declares the model its backend serves, as
`accessModel: 'scoped-keys' | 'iam'` on the orchestrator and, mirrored in
shared, as `accessModelFor(region)` beside `supportsBucketManagement`
(`packages/shared/src/constants.ts:100-102`), so the website can read it
without an orchestrator in hand. Aurora (`eu-west-1`) and FTH (`us-east-1`)
declare `'scoped-keys'`. A Forge region declares `'iam'` once the Hilt network
serving it implements the IAM contract
([§11](#11-the-iam-contract-for-forge)); until then it declares
`'scoped-keys'` and behaves as Aurora and FTH do, which is what its Management
API integration does today. A region's model changes once, in that direction,
per Forge network, and the change is a registry entry
([§12](#12-rollout)).

The console branches on the model of the region in hand. Four user-facing
surfaces read it directly: the key-creation form, the bucket-list filter, the
Bucket policies page, and the role-change flow. Every handler on the route
table of [§4](#4-resolving-access-on-a-request) reads it once to decide whether
to resolve. FIL-1024's per-region matrix discloses it, with three rows this
design adds:

| Capability                                 | Aurora (`eu-west-1`)                  | FTH (`us-east-1`)                     | Forge (`eu-central-3`, `us-east-9`)   |
| ------------------------------------------ | ------------------------------------- | ------------------------------------- | ------------------------------------- |
| Members can be limited to specific buckets | no, role only                         | no, role only                         | yes                                   |
| Existing keys follow a role change         | revoked when they exceed the new role | revoked when they exceed the new role | live; deleted on demotion to ReadOnly |
| A Member's key can create a bucket over S3 | no                                    | yes                                   | no, console only                      |

The Forge column is the region after the flip of [§12](#12-rollout); until
then it reads as FTH.

No production region declares `'iam'` today: `getAvailableRegions` returns the
two vendor regions on production and adds the Forge regions elsewhere
(`packages/shared/src/constants.ts:73-79`), and both Forge endpoints are empty
on production (`sst.config.ts:659-660`). Production customers therefore see no
bucket-policy surface until a Forge region reaches GA, and on the two production
regions nothing about bucket visibility changes: every member of an org sees
every bucket, as today, and the role decides what they may do. FIL-1017's
bucket-scope acceptance criteria are met on IAM regions and not on scoped-key
regions, by decision.

### 2. The scoped-key model

**Keys stay as they are today.** The form is a name, a region, a permission
set, a bucket scope (all buckets or specific ones), and an expiry
(`packages/website/src/components/AccessKeyFormFields.tsx:49-128`). The
creator's role caps the permission set at creation
(`checkCreatorAuthority`,
`packages/backend/src/handlers/create-access-key.ts:207-222`). The bucket list
is the creator's choice: a Member may mint a key to any bucket in the tenant.
That is the accepted limit of the model. A key's stamp, the
console row's `permissions` and `granularPermissions`
(`create-access-key.ts:131-149`), is the only record of what the key carries:
the interface's read-back returns no permissions (`findAccessKeyByName`,
`service-orchestrator.ts:242-245`), so nothing at the vendor can be compared.

A role's **key ceiling** is the set of key permissions the role may hold: the
inverse of `ACCESS_KEY_PERMISSION_REQUIREMENT` plus
`GRANULAR_PERMISSION_REQUIREMENT`
(`packages/shared/src/access-key-permissions.ts:27-36`, `:62-71`) when the role
holds `keys.create`, and empty otherwise. ReadOnly holds `members.read`,
`buckets.read`, and `objects.read` (`packages/shared/src/permissions.ts:121`)
and neither `keys.create` nor `keys.manage_own`, so its key ceiling is empty.

**A role narrowing revokes the keys the holder could no longer mint.** The
rule is one test. A key survives when its holder could mint it today:
`roleHasPermission(newRole, 'keys.create')` holds and
`excessKeyPermissions(newRole, row)` (`access-key-permissions.ts:93-114`) is
empty over the row's stored `permissions` and `granularPermissions`. Otherwise
it is revoked. The mint-time cap and the narrowing check are the same function.
Bucket scope is never compared; `ListAllMyBuckets` is never stored
(`packages/shared/src/api/access-keys.ts:13-15`); a stored value the tables do
not know counts as excess (`access-key-permissions.ts:88-91`, `:113`). A role
without `keys.create` has an empty key ceiling, so demotion to ReadOnly revokes
every key the member created; a survivor would have a holder who cannot see or
revoke it, since `keys.manage_own` is what scopes the list and the delete
(`packages/backend/src/lib/key-scope.ts:37-44`). The same rule applies on IAM
regions for that one case: a member demoted to a role without `keys.create`
has their IAM keys deleted through the core's idempotent `deleteAccessKey`
over the console's key rows for that region, one `key.deleted` event each,
before `syncMember` and the role write, one rule in both models. Every other
narrowing on an IAM region follows live with nothing deleted
([§5](#5-access-keys-belong-to-a-member)).

Computed from `ROLE_PERMISSIONS` (`permissions.ts:73-122`) and the two tables,
the transitions are:

| Change               | Keys revoked                                                 |
| -------------------- | ------------------------------------------------------------ |
| Owner to Admin       | those carrying `PutObjectRetention` or `PutObjectLegalHold`  |
| Owner to Member      | those carrying either privileged granular, or `DeleteBucket` |
| Admin to Member      | those carrying `DeleteBucket`                                |
| Any role to ReadOnly | every key the member created                                 |
| Any promotion        | none                                                         |

The creation-time cap M1 put on a key extends to the role change: a key that
exceeds its holder's new role is revoked with the change. Revocation is
mandatory. Nothing evaluates a retained key live on a scoped-key region, so an
opted-out key would be a standing over-grant with no enforcement behind it.
Widening leaves keys as they are: a promoted member's keys carry less than the
new role until they mint another.

Keys minted before this change by a member since narrowed are the
`pre-member-scope` cohort (`packages/backend/src/lib/dynamo-records.ts:9-23`)
that FIL-1020's review already owns; this rule also revokes them at that
member's next narrowing. The rollout itself revokes nothing
([§12](#12-rollout)).

**Which routes run it.** Any route that lowers a role. `update-member-role`,
including the caller narrowing their own role, which has no self-target guard
(`update-member-role.ts:73-79`; `canChangeRole` is role-based only,
`permissions.ts:190-192`). `transfer-ownership`, where the outgoing Owner
becomes Admin in the same transaction as the promotion
(`packages/backend/src/handlers/transfer-ownership.ts:93-101`), so keys
carrying `PutObjectRetention` or `PutObjectLegalHold` go; the transfer dialog
previews the caller's own keys, under the existing step-up
(`transfer-ownership.ts:181`). And member removal, below.

**Order and guards.** Every local precondition is checked before the first
vendor call: the org-deleting fence, the target's current role as read
(`update-member-role.ts:73`), the `canChangeRole` ceiling, the
pending-invitation set, and, when the change decrements the owner set, the
owner count through `readOwnerCount`
(`packages/backend/src/lib/org-membership.ts:243-256`, a consistent read), so
a sole Owner is refused before any key is touched. The decrement's own
condition (`ownerCount > :one`,
`packages/backend/src/lib/membership-changes.ts:246-256`) stays as the race
guard. The handler then revokes at the vendor and writes the role second, so
the narrowing binds at the storage system first.

Each revocation runs the existing per-key flow, a `key.deleted` intent, the
vendor delete, and the row delete inside the completion
(`packages/backend/src/handlers/delete-access-key.ts:80-108`), with the admin
as actor and `details.reason: 'role_narrowing'`, so every revoked key is
durable on its own and the row never outlives the credential. The commit
revokes from a fresh list read at commit time, never from the dry run's ids,
and after the role write it runs a second pass that revokes any key exceeding
the new ceiling. The key-row write on the mint path carries a `ConditionCheck`
that the creator's membership row still holds the role the cap was evaluated
against; when it fails, the handler revokes the just-minted vendor key and
answers 409. Both guards are needed: the condition alone passes a row that
lands between the listing and the role write, and the second pass alone misses
a row written by a request that read the old role and lands after the pass.

Revocation proceeds key by key across regions. When one vendor fails, the
response lists the keys already revoked and the one that failed, and the role
is unchanged. A role write that fails after the revoke (a concurrent change,
`update-member-role.ts:193`) leaves the keys revoked and the role unchanged,
and the response says so. In both cases the retry is the same PATCH, which
finds fewer keys, since each completion deleted its row; a row whose completion
did not land is revoked again, which `deleteAccessKey` treats as success
(`service-orchestrator.ts:247-252`). Expired keys are deleted on the pass too.
Owner and Admin hold `keys.manage_all` beside `members.manage`
(`permissions.ts:73-110`), so no new permission is needed. Revocation on
narrowing ships to every org, unflagged, as M1's role enforcement did: the cap
it enforces already applies to every org, and the admin confirms each
revocation from the dry run before it happens.

**Unattributed and recovered rows.** Rows written before M1 carry no
`createdBy` (`dynamo-records.ts:40-60`) and are outside the rule until
FIL-1020 attributes or retires them; the dialog shows the org's unattributed
count beside the list ("N keys in this org have no recorded owner and are not
affected"). A `recovered` row is one the console reconstructed after a vendor
409 (`create-access-key.ts:284-305`); its credential was never returned to
anyone, since the retry answers 409 with no secret (`:101-114`), so recovered
rows the member created are revoked with the rest and nothing breaks.

**The admin sees the consequences before confirming.** Demoting another member
gains a confirmation dialog; today every move except promotion to Owner and the
caller's own change applies on the spot (`MembersPage.tsx:471-481`; the dialog
set at `:286-291` has no demotion entry). Its content is, per region the org is
provisioned in, the keys the pass will revoke on scoped-key regions and the
member's policy count on IAM regions
([§6](#6-membership-and-policy-lifecycle-on-iam-regions)). A preview route
feeds it, `GET /api/org/members/{userId}/role-change-preview?role=`, behind
`members.manage` and the same `canChangeRole` ceiling, answering
`{ keys: [{ id, keyName, accessKeyIdSuffix, region, createdAt, excess }], survivingCount, unattributedCount, iamRegions: [{ region, policyCount }] }`.
The `keys` list covers scoped-key regions and, when the target role lacks
`keys.create`, the member's keys on IAM regions; `iamRegions` comes from
`listPolicies(tenantId, { userId })` on each provisioned IAM region and feeds
the dialog of [§6](#6-membership-and-policy-lifecycle-on-iam-regions). The
self-change dialog (`MembersPage.tsx:392-399`)
and the transfer dialog show the same preview in the second person. The dialog
states the safe order: "Keys within the new role survive. To keep a client
running, have the member mint a replacement key with the narrower permissions
first, then change the role." The PATCH response gains `revokedKeys` in the
same shape, which is what happened and may differ from the preview.

**The member is emailed**, since email is the one channel that reaches a
member who is not in the console when their client breaks. The email is sent
after the revocation pass, to the address on the member's
`USER#{userId}/PROFILE` row when it holds one
(`packages/backend/src/lib/user-profile.ts:49-68`; the row learns a verified
address through `rememberVerifiedEmail`, `:89-99`), and otherwise not sent.
The send is best effort and logged, the way invitations are
(`invite-mailer.ts:165-213`), and never fails the change. Subject: "Your
access keys in {org} were revoked". Body: each key's name, access key id,
region, and created date; the old and new role; who made the change; one next
step. The member's key list no longer shows the keys; the audit events are the
durable record. The email is new infrastructure, a small shared mailer beside
the invitation sender. Presigned URLs already issued stay valid until they
expire, in both models ([§8](#8-what-a-member-can-still-see)).

**Removal.** A key never outlives its holder's authority to mint it, and
removal is the narrowing to nothing. Removal revokes the attributed keys the
member created under the same list-revoke-notify pass on scoped-key regions and
through `removeMember` on IAM regions
([§6](#6-membership-and-policy-lifecycle-on-iam-regions)). The email of the
pass lists the keys from both models; on IAM regions `member.removed` carries
the ids, since `removeMember` deletes them in one call
([§9](#9-audit-events)). FIL-1021's per-key
review is confined to the unattributed rows this rule already excludes. The
remove-member dialog copy changes from "keys keep working"
(`MembersPage.tsx:401-412`) to the revocation list.

### 3. What a bucket policy is

A bucket policy belongs to an org and holds a name, one region, a bucket set in
that region, a permission set, and a roster; a bucket may appear in any number
of policies. The bucket set is a list of bucket names or every bucket in the
region, present and future. A policy holding no buckets is valid: it keeps its
roster and its permissions while an admin decides what to point it at. The
policy id is the identity and is minted by the storage system; policy names
need not be unique within an org, the storage system never refuses a name, and
the console warns on a name collision rather than refusing. A policy is
addressed with its region alongside its id, since the id alone does not say
which orchestrator holds it (`region` is a query parameter on every
id-addressed policy route).

The **roster** is the org members the policy applies to. A member can be on
several rosters.

The **version** is an integer the storage system keeps, bumped on every edit to
the policy, its permission set, its bucket set, or its roster, so a concurrent
edit loses cleanly on its conditional bump and an audit event can name the
version it produced.

Who manages a policy is `policies.manage`, a new permission in
`packages/shared/src/permissions.ts` held by Owner and Admin. Those are the two
roles `members.manage` already sits at, so nobody gains or loses an ability on
the day it ships, and the permission names what it governs: editing a policy
changes what everybody on its roster reaches. Reading a policy is
`policies.manage` too: a scoped member learns their reach from the bucket list
and the key form's preview, and the read-only views on the bucket and member
detail pages render for Owners and Admins. The one other creation path is a
scoped member creating a bucket through the console
([§7](#7-bucket-lifecycle-stays-on-keys-as-the-role-permits)). A policy belongs
to the org and never to its creator: removing the creator from the roster
leaves the policy and its other members as they are, and nothing is deleted
recursively.

The **effective permission** on a bucket, for a member, is the union of what
every policy of theirs naming that bucket grants, intersected with the member's
principal ceiling ([§5](#5-access-keys-belong-to-a-member)). A Member on a
read-only policy cannot write that bucket. A ReadOnly member on a read-write
policy can open the bucket and browse it, and nothing more.

A policy's permission vocabulary is thirteen of the fifteen values on an access
key: `read`, `write`, `list`, `delete`, the two bucket-configuration reads
(`GetBucketVersioning`, `GetBucketObjectLockConfiguration`), and the seven
granular data-protection permissions
(`packages/shared/src/api/access-keys.ts:25-28`, `:60-68`). `CreateBucket` and
`DeleteBucket` are excluded because neither acts on a bucket a policy could
name: a key holding `CreateBucket` creates buckets outside its own policy.
Bucket creation stays where the M1 matrix puts it, as the org-level
`buckets.create`. The two mutating granulars, `PutObjectRetention` and
`PutObjectLegalHold`, keep M1's rule: they require `privileged.grant`, which
only an Owner holds, and the ceiling intersection drops them for anyone else,
whatever a policy lists.

Policies exist only in the IAM model, so on an IAM region a Member or ReadOnly
member reaches no bucket until placed on a policy. An admin who wants a Member
unscoped there puts them on a policy whose bucket set is every bucket in the
region. That is the whole of per-member unscoping. A flag on the membership
row would be a second source of access the storage system cannot evaluate, so
none exists.

The resemblance to S3's own bucket policy stops at the name. This is a rule
over a set of buckets with a member roster, the shape of an IAM policy attached
to a group, with no `Deny`, no conditions, and no principals outside the org.
Overlapping policies therefore compose by union and only ever add access, which
costs precision: an admin who narrows one policy has not narrowed the member if
another of their policies still grants what was removed. That belongs in the
console copy beside the policy editor.

**The Bucket policies page** is an org-level page, the editor for a policy's
rule and roster, gated on region availability (`getAvailableRegions(stage)`
includes an IAM region) and absent otherwise, which is production today. It
lists IAM regions only. Policy creation calls `ensureTenantReady` for the
chosen region, so an org with no Forge bucket can still create its first
policy. Two read-only views feed off it, on the bucket detail page and the
member detail page; the member detail line on scoped-key regions reads "In
Europe (France) and US East (Michigan) every member sees every bucket and the
role decides what they may do." All of it sits behind the `ORGS_BETA` row
pattern (`packages/backend/src/lib/orgs-beta.ts:5-24`), where granting is a
row instead of a redeploy.

### 4. Resolving access on a request

The console stores no policy rows: no console table for policies, no
membership-row marker, no backfill. The console keeps orgs, memberships,
roles, key attribution, and the audit log. The enforcing system owns the rules
it enforces, so no console-to-storage sync channel exists to drift.

On an IAM region the console decides "unscoped" from the role and calls
`resolveMemberAccess` for Member and ReadOnly only:

```ts
export type BucketAccess =
  | { sees: 'all' }
  | { sees: 'policies'; buckets: Map<string, Set<AccessKeyPermission>> };
```

The map is keyed `{region}/{bucketName}`; S3 bucket names contain no `/`, so
the key composes unambiguously, and it answers both questions a route asks: is
this bucket in reach, and with which permissions. A policy over every bucket
resolves into the map as the region's buckets at the time of the read; the
per-request read is what makes a later bucket appear. `{ sees: 'all' }` is the
answer for an all-buckets principal; it reaches the console through the key
read and `listAccessKeys` for an unscoped member's key
([§5](#5-access-keys-belong-to-a-member),
[§10](#10-the-orchestrator-interface)), while `resolveMemberAccess`, called for
scoped members only, answers with the map. It is called once per request and
never cached across requests, so a roster or role change binds on the member's
next console request; the storage system's read must be consistent with its
own last write. It is one round trip per bucket-addressed request on an IAM
region, accepted. When it is unanswered the request fails closed. One
orchestrator answers for one region, so a fan-out route asks each provisioned
IAM orchestrator and a bucket-addressed route asks one; scoped-key regions are
never resolved and never filtered.

Console traffic on Forge is signed with the tenant's `filone-console` key, the
one credential that belongs to no member, and is authorized by the console
alone: the route table below is normative, and every bucket-addressed route on
it resolves the caller's access in the handler; the membership and policy rows
are there because they write what the resolution reads. The check runs in the
handler because
`authorize()` decides from the route manifest alone and the manifest cannot
name a bucket, while the bucket arrives in a path parameter or, for
`POST /api/presign`, in each element of the body. This is the `in-handler`
requirement M1 already defines for presign.

On a Forge region a scoped member's console pages therefore depend on Hilt's
management API being up; the S3 data plane does not, because the gateway
serves warm keys from its cache ([§11](#11-the-iam-contract-for-forge)). While
Hilt is unreachable, a scoped member's bucket-addressed console reads fail
closed and every narrowing write that touches Forge
(role change, removal, key revocation) is refused, so containment on Forge
waits for Hilt; direct keys keep working from the gateway's cache until the
invalidation of [§5](#5-access-keys-belong-to-a-member) reaches them. Unscoped
members are unaffected on the read path, since the role settles their access
before the interface is crossed.

| Route                                                            | Behavior                                                                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/buckets`                                               | filter the region's part of the merged fan-out result to the resolved set for a scoped caller                                                   |
| `POST /api/buckets`                                              | allowed; a scoped creator's bucket joins a policy in the same request ([§7](#7-bucket-lifecycle-stays-on-keys-as-the-role-permits))             |
| `GET /api/buckets/{name}`                                        | absent from the set gives the same 404 a missing bucket gives                                                                                   |
| `DELETE /api/buckets/{name}`                                     | gated on `buckets.delete`, which only an unscoped caller holds                                                                                  |
| `GET /api/buckets/{name}/analytics`                              | 404 when out of reach                                                                                                                           |
| `GET \| POST /api/buckets/{name}/rag/enabled`                    | 404 when out of reach                                                                                                                           |
| `POST /api/buckets/{name}/bulk-delete`                           | 404 when out of reach; requires resolved `delete` on the bucket before the job is created                                                       |
| `GET /api/bulk-delete-jobs/{jobId}`                              | the job row names its bucket; check that bucket, 404 otherwise                                                                                  |
| `GET /api/activity`                                              | filter the region's bucket entries to the resolved set                                                                                          |
| `POST /api/presign`                                              | per operation, the bucket in the set and the effective permission for it; one denial refuses the batch                                          |
| `POST /api/buckets/{name}/query` (bearer)                        | the bearer branch resolves the key creator's membership, so that member's live access applies                                                   |
| `POST /api/access-keys`                                          | minted for the caller; the response and the form preview carry the member's reach ([§5](#5-access-keys-belong-to-a-member))                     |
| `POST /api/rag-api-keys`                                         | bucket refs must sit inside the caller's resolved access                                                                                        |
| `POST /api/org/invitations`                                      | carries region-qualified policy ids ([§6](#6-membership-and-policy-lifecycle-on-iam-regions))                                                   |
| `PATCH /api/org/members/{userId}`                                | the principal write path; on scoped-key regions, the revocation pass ([§2](#2-the-scoped-key-model))                                            |
| `GET /api/org/members/{userId}/role-change-preview`              | `members.manage`; the dry run behind the demotion, self-change, and transfer dialogs                                                            |
| `POST /api/org/transfer`                                         | the outgoing Owner's narrowing to Admin: `syncMember` on IAM regions, the revocation pass on scoped-key regions ([§2](#2-the-scoped-key-model)) |
| `DELETE /api/org/members/{userId}`                               | `removeMember` on every provisioned IAM region; the revocation pass on scoped-key regions                                                       |
| `GET \| POST /api/bucket-policies`                               | list and create, `policies.manage`; create calls `ensureTenantReady` for the chosen region                                                      |
| `GET \| PATCH \| DELETE /api/bucket-policies/{policyId}?region=` | read, edit with `version`, delete, `policies.manage`                                                                                            |
| `POST \| DELETE /api/bucket-policies/{policyId}/members?region=` | roster changes with `version`, `policies.manage`                                                                                                |

**An out-of-reach bucket answers exactly like a bucket that does not exist.**
Same status, same body, no new `ApiErrorCode`, since a distinct code would
confirm the bucket exists. That costs a worse message for a member whose access
was removed while their tab was open, who gets "Bucket not found" where "your
access was removed" would be truthful.

`POST /api/presign` refuses the whole batch on one denial, per M1's rule. The
batch carries one `region` query parameter covering every operation
(`presign.ts:246`), so the handler resolves the caller's map once and checks
each operation's bucket and verb against it.

A queued bulk-delete job runs to completion, because the job row carries no
creator (`packages/backend/src/lib/bulk-delete-jobs.ts:89-110`) and the worker
drains its queue after the request returns. Removing somebody from a policy
stops them reading the job's status while their deletion finishes unannounced,
which is why the job requires resolved `delete` before it is created.

### 5. Access keys belong to a member

In the IAM model a key request is a name, a region, and an optional expiry.
`permissions`, `granularPermissions`, and the bucket-scope fields are absent
from the request on an IAM region. The principal is always the caller:
`POST /api/access-keys` carries no `userId`, the handler passes its own, and
minting on behalf of another member is not offered. Today `keys.create` is
"Mint a new access key or RAG key" (`permissions.ts:45-46`) and the handler
attributes the key to the caller (`create-access-key.ts:59-61`); that stays so.

In both models a key carries no more than its holder. The role caps a
scoped-key-model key at creation and the revocation pass of
[§2](#2-the-scoped-key-model) holds it there; an IAM-model key is evaluated
through its member on every request, so no key can be minted, edited, or kept
above the policies and ceiling that bound the member.

A role's **principal ceiling** is the inverse of the two requirement tables,
computed for every role, ReadOnly included. ReadOnly's is `read`, `list`, the
two bucket-configuration reads, and the read-side granulars, because a
ReadOnly member's console access on Forge resolves through their principal and
they can browse a bucket a policy names. Only the key ceiling of
[§2](#2-the-scoped-key-model) is empty for ReadOnly.

The key's authority is the member's effective access as the storage system
evaluates it: the principal ceiling over every bucket for an unscoped member;
for a scoped member, the union of their policies in that region intersected
with the ceiling, per bucket. The access key id and secret survive every
change except demotion to a role without `keys.create`, which deletes the
member's keys in both models, through the per-key flow of
[§2](#2-the-scoped-key-model) and the core's `deleteAccessKey` on an IAM
region. A widening binds on the key's next cache miss at the gateway: a
command with no cached chain always goes to Hilt, and bucket-level operations
are never served from the gateway cache. A narrowing binds when Hilt revokes
the delegations the change invalidates and the gateway's revocation consumer
clears the affected keys' caches. That propagation is the staleness bound
Forge publishes (FIL-1018), and today's ceiling on it is the next UTC midnight
plus clock skew, which holds even with the revocation service down: the
gateway's re-delegation and verification key both expire then (code for all
of this at [§11](#11-the-iam-contract-for-forge), Today). A role narrowing on
an org with an IAM region can fail on a revocation-service outage, because
Hilt publishes revocations before it acknowledges a change; that surfaces as a
failed, retryable role change.

A key read returns the member's access in the same `BucketAccess` shape
`resolveMemberAccess` returns; the console shows that, and an IAM row carries
no stamp. Where a member's policies grant different verbs on different
buckets, the per-bucket map says so exactly; a flat key could not.

**Empty reach.** A key may be issued to a member with no reachable bucket. It
authorizes nothing until a policy names them, and the form says "reaches no
bucket yet". A key bound to a member gains authority the moment the member
joins a policy, with no reissue. Every principal holds `s3:ListAllMyBuckets`
unconditionally, as every key does today, so such a key still lists names
([§8](#8-what-a-member-can-still-see)).

**Key names** are unique per principal on an IAM region. AWS keys have no
names; the name is the console's label. Hilt enforces `UNIQUE (tenant_id, name)`
today (fil-forge/hilt `pkg/migrations/sql/00001_init.sql:26-35`) and the
console recovers a vendor 409 by scanning the org's rows for the name and, when
none exists, adopting the vendor's key by name
(`create-access-key.ts:256-265`, `:269`). `findAccessKeyByName` therefore lives
on the scoped-keys arm only; on the IAM arm the 409 recovery lists the caller's
own keys and matches by name, which cannot land on another principal's key.

**The console key record.** The console still writes its key row
(`UserInfoTable` `ORG#{orgId}/ACCESSKEY#{id}`, `dynamo-records.ts:40-60`) for
every key: it is the org-level index (one partition query serves the merged
list), the `keys.manage_own` scope input (`createdBy`), and the `key.created`
audit anchor. Permissions are never on an IAM row. `policyVersion` takes its
next values: scoped-key rows minted after the narrowing rule ships carry
`'role-capped'`, IAM rows carry `'member-derived'`, so FIL-1020's review can
tell the cohorts apart by the field it was built to read
(`dynamo-records.ts:9-23`). The list and its join are in
[§10](#10-the-orchestrator-interface).

**The key form on an IAM region** is a name and an expiry, with a reach
preview: every bucket for an unscoped member, and for a scoped member the map
from `resolveMemberAccess` (or "reaches no bucket yet"). The bucket page's key
button (`packages/website/src/components/AddBucketKeyModal.tsx:18-24`,
`:41-51`, header at `:65`) opens the same member-key form on an IAM region, and
the preview shows whether this bucket is in reach.

**RAG API keys** already resolve the creator's live membership at query time
and refuse when it is gone (`packages/backend/src/middleware/rag-query-auth.ts:139-149`,
`:170-175`). On an IAM region their bucket refs are checked against
`resolveMemberAccess` for the creator at creation and on every query, since
the bearer branch resolves the creator's membership per request; on scoped-key
regions nothing bucket-level exists to check. Because their authority resolves
live, they sit outside the revocation pass of [§2](#2-the-scoped-key-model).

### 6. Membership and policy lifecycle on IAM regions

**A principal is `(tenantId, userId)`.** `userId` is the console's user id, a
UUID minted at first sign-in (`packages/backend/src/middleware/auth.ts:430`),
opaque to the storage system, unique across tenants, and the same string
`createdBy` and the audit log carry, so a key read from Hilt joins the console's
key record without a mapping table. The role name never crosses the interface:
the console maps the role to the principal ceiling; the storage system knows
principals, and the role name stays in the console.

On Forge `tenantId === orgId` today: `PUT /tenants/{tenantId}` is idempotent on
a client-supplied id and FilOne uses the org id verbatim
(`tenant-setup.ts:6-11`, `:118-123`). A Hilt tenant is one region: the org id
is the tenant's unique external id, a tenant has one provider, a provider is
one region, and provisioning an existing id returns the existing tenant
whatever region is asked for (fil-forge/hilt `00001_init.sql:3-17`;
`pkg/api/service/tenant/service.go:74-79`). Principals and policies are
therefore region-local by construction. A second Forge region for one org on
the same network needs a Hilt tenant per (org, region), which the Forge
implementation gets by sending a region-qualified external id; the
`${id}TenantId` PROFILE attribute already stores one tenant id per region
(`orchestrator/orchestrator.ts:107`, `:151-155`). Until that ships, one Hilt
network serves one region per org. A second region on the same Hilt today
would 409 on `filone-console` and take the "rotating the key" branch
(`tenant-setup.ts:251-283`), revoking the first region's console credential; that
is a latent bug independent of this design.

**The principal write path** owns the IAM promise that keys always reflect the
member's current permissions.

(a) Provisioning. `ensureTenantReady` on an IAM region writes a principal for
every current member before the readiness pointer, and the region counts as
provisioned only after that sweep. Tenant setup runs synchronously inside the
first resource-creating request
(`2026-05-synchronous-tenant-setup-on-first-resource.md`), so the sweep is N
Hilt calls inside that request, accepted; a batched principal write is part of
the ask ([§11](#11-the-iam-contract-for-forge)).

(b) Membership writes. The order depends on direction. A narrowing (role down,
removal) binds at the storage system first, `syncMember` or `removeMember`
(and, for demotion to a role without `keys.create`, the per-key deletion of
[§2](#2-the-scoped-key-model)) on every provisioned IAM region and then the
console row; a failed sync fails the
change. A widening (role up, and a new membership on invitation accept) commits
the console row first and syncs second; a failed post-commit sync leaves the
member no wider at the gateway than in the console, the audit completion names
the region still to sync, and the re-drive is idempotent. At no point is a
principal wider at the gateway than the console role that authorized it. The
preflight of [§2](#2-the-scoped-key-model) applies to both orders, so a
transaction that would cancel on the owner counter or the target's role is
refused before Hilt is called.

Every `syncMember` carries a `revision`, a counter on the membership row bumped
on every role write. Hilt keeps the highest revision seen and treats an equal
or lower one as a no-op, so re-drives are safe in any order and two admins
racing cannot leave the gateway at the loser's state. `revision` is absent on
today's membership rows and reads as 0; the next role write sets it, so no
backfill ships. A principal Hilt does not know is a member with no access.

(c) First use is any IAM call for that member in that region. When the region
reports no principal, the console syncs before the call, so a member's first
bucket list on a newly provisioned region resolves against a principal that
exists.

(d) A drift job on the `subscription-drift-checker.ts` pattern
(`packages/backend/src/jobs/subscription-drift-checker.ts`) compares each
membership's revision, and the ceiling computed from the current tables, to
each IAM region's principal, re-drives where it lags, and deletes a principal
whose membership row no longer exists, which also covers a `syncMember`
re-drive that lands after `removeMember`. This is also how a
change to the role matrix or the requirement tables reaches every principal,
since a deploy that alters `ROLE_PERMISSIONS` has no membership event of its
own; FIL-1019's per-operation grants are planned inside M2 and change what an
Owner's ceiling contains.

**Invitations.** An invitation carries region-qualified policy ids on the
invitation row M1 already writes. Acceptance is a widening: the membership row
commits first, then `syncMember` and the roster adds on each provisioned IAM
region; policies deleted in the 14-day window are skipped and named in the
`invite.accepted` completion ([§9](#9-audit-events)). An invitation states
intent, and failing the acceptance for an admin's deliberate deletion would
punish the invitee for it. An Owner or
Admin invitation carries no policies, since both roles are unscoped.

**Policy edits**, roster changes, and deletions change effective access with
no key touched ([§5](#5-access-keys-belong-to-a-member)). A stale preview
loses on the policy's `version`.

**Demotion to Member** on an IAM region scopes the member from that moment.
The dialog of [§2](#2-the-scoped-key-model) states, for that region: "On
{region label} this member will reach only the buckets their policies name.
They are on N policies (or none, so they will see no bucket there until added
to one), and their keys in that region follow immediately." Demotion to
ReadOnly says instead that their keys in that region are deleted
([§2](#2-the-scoped-key-model)). The response links to the Bucket policies
page filtered to the member. Region labels come from `REGION_LABELS`
(`packages/shared/src/constants.ts:26-31`).

**Promotion** leaves rosters in place. An unscoped member's rosters are inert,
and the console renders them as inactive, so a later demotion reuses them.
Enforcing a policy against an Admin would protect nothing anyway, since an
Admin holds `policies.manage` and can add themselves to any policy in one
request.

**Removal** calls `removeMember(tenantId, userId)` on every provisioned IAM
region before the membership rows are deleted (a narrowing, so the order in (b)
applies). `removeMember` deletes the principal and every key bound to it,
leaves every roster it was on, and is idempotent. A policy whose roster empties
survives ([§3](#3-what-a-bucket-policy-is)). A failed call fails the removal.
The member's console key rows for that region
are deleted in the membership transaction, bounded to that member's rows.

**Org deletion** needs no new path: `deleteTenant` destroys principals,
policies, and keys with the tenant (`service-orchestrator.ts:221-230`;
`packages/backend/src/jobs/account-deletion-worker.ts:117-132`), and the scrub
reads the whole `ORG#{orgId}` partition, key rows included
(`packages/backend/src/lib/deletion-scrub.ts:75-87`).

### 7. Bucket lifecycle stays on keys as the role permits

The key form stays as it is on scoped-key regions, bucket-management
checkboxes included. `aws s3 mb` keeps working on FTH as today, and on Forge
for an Owner's or Admin's key; a Member's key on Forge loses it at the flip,
the one thing the IAM model takes from a key that works today
([§12](#12-rollout)). Existing FTH keys carrying the two permissions are
untouched until a narrowing leaves them above the holder's role
([§2](#2-the-scoped-key-model) table). In the scoped-key model the role cap
governs `CreateBucket` and `DeleteBucket` as it
governs every other permission: `buckets.create` is Member and above,
`buckets.delete` Admin and above (`permissions.ts:73-122`;
`access-key-permissions.ts:32-33`). In the IAM model an unscoped member's key
authority includes them per the principal ceiling; a scoped member's never
does, since the policy vocabulary excludes them
([§3](#3-what-a-bucket-policy-is)). So a Member's key can create a bucket over
S3 on FTH and not on Forge, where a Member creates buckets through the console
only; Owner and Admin keys can on both; Aurora has no S3 bucket management at
all (`supportsBucketManagement`, `constants.ts:100-102`; the schema refusal at
`api/access-keys.ts:204-210`). FIL-1024's matrix shows it
([§1](#1-two-access-models-declared-per-orchestrator)). Taking the two
operations off every customer key is recorded under
[Options considered](#options-considered).

What is given up is observation. Key-mediated lifecycle on FTH, and on Forge
for unscoped members, stays unobserved: the Management API has no event or
audit surface, an S3 `ListBuckets` returns a name and a creation date, and no
contract exposes which key acted. FIL-1019's bucket-lifecycle half therefore
reopens, and the `bucket.created` and `bucket.deleted` audit events are written
for console-mediated lifecycle only ([§9](#9-audit-events)). A lifecycle feed
from an orchestrator is the ask that closes it
([Open questions](#open-questions)).

**A bucket a scoped member creates through the console joins a policy in the
same request.** `POST /api/buckets` on an IAM region carries either the id of
an existing policy the creator is on, or a new policy of one fixed shape: it
names exactly the new bucket, never every bucket; its roster is exactly the
creator; its permission set is the creator's principal ceiling restricted to
the policy vocabulary of [§3](#3-what-a-bucket-policy-is), so for a Member
everything but `CreateBucket`. The console refuses any other shape, because
the bucket-create path is the one policy-creating call a Member holds, and a
Member who could author an all-buckets policy would be unscoped. Naming the
policy explicitly puts the blast radius in front of the
person creating the bucket: adding the bucket to every policy the creator is
on would grant it to everybody else on those rosters without anyone asking.
Editing the policy afterwards, including adding a teammate, is
`policies.manage`, so an Owner or Admin does that. An unscoped creator names
no policy.

On Forge the bucket is created first, an S3 `CreateBucket` signed with the
console credential (`orchestrator/orchestrator.ts:228-256`), and joined second,
a management-API call. The two cannot be one call today, and the reverse order
is unavailable: a policy grant at Hilt is a delegation whose subject is the
bucket's DID (fil-forge/hilt `00001_init.sql:37-45`;
`pkg/rpc/service/bucket/service.go:129-141`), and Hilt refuses a key naming an
unknown bucket (`pkg/api/service/accesskey/service.go:101-128`). A failure
between the two leaves a bucket the creator cannot see. The console retries the
join on the same request keyed by bucket name; when the retry fails too, the
response says the bucket exists and the join did not, and an Owner or Admin
repairs it by adding the bucket to a policy. A management-API bucket-create
route that takes the policy join would make the two one call and is part of the
Forge ask if Forge prefers it ([§11](#11-the-iam-contract-for-forge)).

**Deleting a bucket on an IAM region removes it from every policy naming it at
the storage system.** Hilt already revokes and deletes every delegation whose
subject is the deleted bucket and leaves all-buckets grants alone, since those
carry no subject (fil-forge/hilt `pkg/rpc/service/bucket/service.go:244-280`,
`:295-335` at origin/main). That is the right semantics for a policy over
every bucket in the region. Nothing is revoked on a key, because no key holds
authority of its own.

### 8. What a member can still see

Org-wide aggregates stay org-wide, so a scoped member can still learn that
other buckets exist. `GET /api/usage` and `/api/usage/trends` report org-wide
bytes and object counts, the dashboard's bucket count and key count are
org-wide totals, and `GET /api/billing` is org-wide by construction because the
subscription is the org's. Closing those means a per-bucket breakdown on each
aggregate, and then the numbers a scoped member sees stop matching the invoice.

**Enumeration over S3 is a name listing everywhere.** `aws s3 ls` reaches the
storage gateway directly and never touches a FilOne handler, and every key
FilOne mints carries `s3:ListAllMyBuckets` unconditionally (`ALWAYS_PERMISSIONS`,
`orchestrator/orchestrator.ts:497`; `FTH_ALWAYS_PERMISSIONS`,
`fth-orchestrator.ts:382`; on Aurora the action rides inside the `Default`
grant, `aurora-portal.ts:107`, and is always allowed,
`docs/S3Considerations.md:350`). Measured on staging (2026-08-26), FTH lists the
whole tenant on any key. Forge lists the whole tenant too: Hilt's
`/s3/bucket/list` returns one page of all the tenant's buckets after checking
only that the key holds `s3:ListAllMyBuckets` (fil-forge/hilt
`pkg/rpc/service/bucket/service.go:310`; `pkg/rpc/service/auth/operation.go:42`),
and fil-forge/hilt PR #48, which scoped the listing to the key's buckets, was
closed 2026-08-27. Aurora filters. The output is names alone: a key cannot
read, write, or delete an object in a bucket it does not reach, and the console
shows the member nothing outside their policies. `aws s3 ls` against AWS itself
lists names the caller cannot open, so a name in that output has never meant
access. AWS's listing behavior is neither a target nor a requirement here.
FIL-1017's ListBuckets criterion is met on Aurora and unmet on FTH and Forge
([Open questions](#open-questions)).

Bucket names reach a scoped member one other way. `HeadBucket` against a bucket
outside a key's scope answers 403 instead of 404 on Aurora and FTH (measured on
staging, 2026-08-26), and Forge is unmeasured, so a member who guesses an exact
name confirms it exists, and closing that would need the gateway to lie about
existence. It is not closed, on any region.

Presigned URLs already issued stay valid until they expire, up to 7 days for
downloads (`presign.ts:42-43`), which is the console-side bound for object
reads after a policy change or a role narrowing, in both models. How fast a
narrowing binds at the storage system is [§5](#5-access-keys-belong-to-a-member)'s
staleness bound on Forge and the revocation itself on Aurora and FTH.

The activity feed is scoped on IAM regions, because it names individual
buckets. `fetchBucketActivities` calls `orchestrator.listBuckets(tenantId)` in
each provisioned region and renders one entry per bucket, carrying the name
(`packages/backend/src/handlers/get-activity.ts:138-172`), which would hand
every bucket name in the region to every role. The handler filters those
entries against the same resolved map `GET /api/buckets` uses. Key entries need
no change, since M1 already narrows them by `createdBy` under
`keys.manage_own`.

### 9. Audit events

M1 shipped the audit write path with a closed list of ten event types
(`packages/shared/src/audit.ts:37-48`); the membership ones are
`member.role_changed`, `member.removed`, and `ownership.transferred`, and the
key ones `key.created` and `key.deleted`. FIL-1022's first acceptance
criterion asks for membership changes including scope, so this design adds the
events while FIL-1022's own design owns the viewer, the retention, and the
export.

A role change that revokes keys or syncs a principal crosses the interface, so
`member.role_changed` takes M1's intent-and-completion pair: the intent before
the first write in either order (before the vendor call on a narrowing, before
the console transaction on a widening), naming the target role and the keys
the dry run selected; the completion after the last write, the second
revocation pass included, carrying the revoked ids, the synced regions, and
the member's policy count on IAM regions. `commitAudited` keeps the role
changes that touch no vendor, which on scoped-key regions is every promotion
and every narrowing that finds no key. A crash between the two leaves a
visible dangling intent instead of revoked keys with no record.
`ownership.transferred` takes the same pair when the outgoing Owner's keys are
revoked or their principal is synced, since transfer is the role change the
outgoing Owner undergoes; its completion carries the revoked key ids
(`packages/backend/src/handlers/transfer-ownership.ts:105-115`).

Per-key `key.deleted` events with `reason` are the record of a revocation pass;
`member.role_changed` carries the ids as the summary. Without the per-key
events a pass that fails midway would leave revoked credentials with no record
at all, since `member.role_changed` is written inside the role transaction,
which cannot run until the pass ends. `member.removed` records the keys revoked
and the IAM regions whose principal was removed.

The policy events, `bucket_policy.created`, `bucket_policy.updated`,
`bucket_policy.deleted`, and `bucket_policy.members_changed`, take the
intent-and-completion pair around the interface call, the completion carrying
the version the storage system produced. One event per action is the same rule
that keeps a per-bucket `bucket.granted` out of the design: a policy edit
touching twenty members would otherwise write twenty events. Replaying the
policy events and the roster events together answers "what could this person
reach in March". `member.invited` and `invite.accepted` carry policy ids on IAM
regions. `bucket.created` and `bucket.deleted` are written for console-mediated
lifecycle, carrying the acting user, the region, the bucket name, and, on an
IAM region, the policy the bucket joined.

Denials are not logged. A scoped member hitting a bucket outside their
policies gets a 404, and one event per 404 turns the audit log into a traffic
log. FIL-1022 scopes itself to control-plane events, and request-level logging
is FIL-949.

### 10. The orchestrator interface

The interface today is tenant-addressed on every key call and has no
capability flags (`service-orchestrator.ts:167-284`); the only per-region flag
is `supportsBucketManagement` in shared. It becomes a discriminated union:

```ts
type ServiceOrchestrator = ScopedKeyOrchestrator | IamOrchestrator;
```

Both arms extend `OrchestratorCore`, which is what every region shares today:
tenant lifecycle (`ensureTenantReady`, `isTenantReady`, `updateTenantStatus`,
`deleteTenant`, `getTenantStatus`), buckets, `getS3ClientContext`, usage, and
the idempotent `deleteAccessKey`. One interface, two access surfaces. The IAM
arm has the shape of the IAM API without its request bodies: `syncMember` and
`removeMember` are the user lifecycle, a bucket policy is a policy attached to
a group, `issueMemberKey` is `CreateAccessKey` for the caller, and the role
name never crosses. A vendor that adds principals and policies moves its
region to `'iam'` by implementing that surface, and nothing in the console
changes; until it does, its keys carry the flat permission set the scoped-keys
arm issues, and no console-side union widens them
([Options considered](#options-considered)).

The **scoped-keys arm** is `accessModel: 'scoped-keys'`,
`issueAccessKey(tenantId, opts)` with today's `IssueAccessKeyOpts`, and
`findAccessKeyByName`. Unchanged.

The **IAM arm** is `accessModel: 'iam'` and:

| Method                                                      | Contract                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syncMember(tenantId, principal)`                           | `principal = { userId, revision, permissions: AccessKeyPermission[], granularPermissions: GranularPermission[], allBuckets: boolean }`; `allBuckets` is true for Owner and Admin; `revision` semantics in [§6](#6-membership-and-policy-lifecycle-on-iam-regions) |
| `removeMember(tenantId, userId)`                            | deletes the principal and every key bound to it, leaves every roster it was on, idempotent                                                                                                                                                                        |
| `createPolicy`, `getPolicy`, `updatePolicy`, `deletePolicy` | region-local; `updatePolicy` and `deletePolicy` take the `version` they read for a conditional edit                                                                                                                                                               |
| `listPolicies(tenantId, filter?: { userId?, bucket? })`     | serves the policies page, the member detail view, and the bucket detail view                                                                                                                                                                                      |
| roster add and remove                                       | by policy id and `userId`; take the `version` they read for a conditional edit                                                                                                                                                                                    |
| `resolveMemberAccess(tenantId, userId)`                     | returns `BucketAccess` ([§4](#4-resolving-access-on-a-request))                                                                                                                                                                                                   |
| `issueMemberKey(tenantId, userId, { keyName, expiresAt? })` | named apart from the scoped arm's method so the union narrows                                                                                                                                                                                                     |
| `listAccessKeys(tenantId, { userIds? })`                    | identity fields plus the principal and its `BucketAccess`                                                                                                                                                                                                         |

Two types are kept apart on purpose: `AccessKeyPermission` and
`GranularPermission` are separate unions in shared
(`api/access-keys.ts:32-37`, `:60-69`) and `IssueAccessKeyOpts` already carries
them as two fields, so the principal does too.

**The key list.** The console's key rows are the list. The handler queries the
org's rows as today (`packages/backend/src/handlers/list-access-keys.ts:62-68`),
then calls `listAccessKeys(tenantId, { userIds })` once per provisioned IAM
region and joins by key id to fill effective access. `keys.manage_own` filters
the console rows (`list-access-keys.ts:90-116`), so the join never widens what
a Member sees. A row the orchestrator does not return shows "not active at the
storage system" to `keys.manage_all`; a storage-system key with no row is not
shown and is logged, the tenant's `filone-console` key being the expected case.
When an IAM region does not answer, its rows are listed with permissions
unknown and a per-region warning, since listing a key is not an access
decision. `AccessKey.permissions` (`api/access-keys.ts:214-226`) becomes the
effective set on every row, the stamp on scoped-key rows and the orchestrator's
answer on IAM rows; the bucket-scope flag and `buckets` are absent on IAM rows;
a per-bucket variant carries a scoped member's map. The bucket page's key
filter, today a `contains(buckets, :bucket)` predicate on the row
(`list-access-keys.ts:41-45`), is answered for IAM rows from the joined
`BucketAccess`.

**Tests.** Two fakes, typed against the union. The scoped-keys fake keeps
today's stubs (`packages/backend/src/test/fake-orchestrator.ts:10-20`, which is
untyped against the interface and stubs no key method; `FakeOrchestratorOpts`
gains `accessModel`, default `'scoped-keys'`). The IAM fake is an in-memory
reference implementation of the contract, principals, policies, keys, and
`resolveMemberAccess`, the executable form of the requirements list in
[§11](#11-the-iam-contract-for-forge), shared by the console tests and the
Forge team.

### 11. The IAM contract for Forge

These requirements are a revision of the Management API contract
(`docs/service-orchestrator-integration/management-openapi.yaml`, "Management
API that a Service Orchestrator must implement so FilOne can integrate it as a
new region", `:1-9`), the file Hilt implements and `@filone/orchestrator-client`
is generated from (`tenant-setup.ts:20-29`; `2026-03-openapi-client.md`). They
are added as an optional capability set; the console sets
`accessModel: 'iam'` for a Forge region when its network serves that revision;
only Forge is asked to implement it. The REST shapes and a latency target for
the member-access read, which sits on the console request path, land in that
file.

**Today.** Hilt owns tenants, their access keys, and their buckets, plus the
UCAN delegations that back them, behind a pre-shared partner key
(fil-forge/hilt `pkg/echo/middleware/partnerkey.go`). Its REST surface is eight
routes, four on tenants and four on access keys (`pkg/fx/api.go:18-26`); no
route updates a key, and the store is `Add`, `Get`, `ListByTenant`, `Delete`
(`pkg/store/accesskey/accesskey.go:28-43`). A key is a flat row,
`permissions TEXT[]` and `buckets TEXT[]` (`00001_init.sql:26-35`), evaluated
per request by two membership tests (`pkg/rpc/service/auth/auth.go:184-187`,
`:201-204`). At key creation Hilt stamps tenant-to-key delegations, one per
command and subject, the subject being each bucket DID or the undefined
"powerline" subject for a tenant-wide key
(`pkg/api/service/accesskey/service.go:176-205`). Per request it re-delegates
each command from the key to the gateway with the bucket as subject, expiring
at the next UTC midnight plus clock skew, capped at key expiry
(`pkg/rpc/authorize.go:97-107`, `:116-127`); the gateway caches those chains
and the derived verification key to the same horizon and serves the next
request from cache without asking Hilt; bucket-level operations are never
served from that cache (fil-forge/ingot `iam/service.go:296-352`, `:325-334`,
`:214-222`; `iam/proofcache.go:16-19` at origin/main). There is no principal,
user, member, role, or policy object anywhere.

On origin/main Hilt publishes revocations to the Swarf revocation service on
key delete and bucket delete, before deleting its own rows, and fails the call
on a revocation-service error so the operation stays retryable
(`pkg/api/service/accesskey/service.go:282-312`; `bucket/service.go:244-280`;
`pkg/config/config.go:188-189`, all at origin/main), and Ingot's `Revoker`
consumes those revocations and drops a revoked key's whole cache so its next
request goes back to Hilt (`iam/revoker.go:11-18`, `:34-53`;
`iam/keyproofs.go:63-89`; `module.go:411-431` at origin/main). That is the one
existing path for pushing a change to a warm key.

**Required.**

0. A tenant keeps one service credential outside the principal model: the
   console's `filone-console` key, tenant-wide and unexpiring, minted at
   tenant setup before any principal exists (today's `CreateAccessKeyRequest`,
   `management-openapi.yaml:585-612`, stays as the tenant-scoped shape). It is
   not a customer key and sits
   outside the key list, the member-bound key rules of
   [§5](#5-access-keys-belong-to-a-member), and the revocation pass of
   [§2](#2-the-scoped-key-model).
1. Principals per tenant: `(tenantId, userId)` with a permission ceiling, an
   all-buckets flag, and a revision applied only when higher. A batched
   principal write for the provisioning sweep.
2. Bucket policies: storage-minted id (names not unique; the storage system
   never refuses a name), region-local, bucket set (a possibly empty list of
   names, or all buckets), permission set, roster of principals, version for
   conditional edits, list by principal and by bucket. The management API
   carries no actor; who may edit a policy is decided by the console
   ([§4](#4-resolving-access-on-a-request)).
3. Keys bound to a principal, issued with name and expiry only; names unique
   per principal.
4. Per-request authority at Hilt is `ceiling ∩ (allBuckets ? all : union of policies)`,
   per bucket; bucket-level operations are never served from the gateway
   cache. Read-back returns the principal and its access in the `BucketAccess`
   shape; the flat `permissions` and `buckets` fields on today's `AccessKey`
   (fil-forge/hilt `pkg/api/types.go:36-43`) do not describe an IAM key. A
   member-access read returns a principal's access in the same `BucketAccess`
   shape, is consistent with Hilt's own last write, and backs
   `resolveMemberAccess`; its latency target lands in the contract file.
5. Every narrowing of a principal or policy publishes revocations for the
   delegations it invalidates before Hilt acknowledges the change. The
   propagation time under a healthy revocation path is the published staleness
   bound (FIL-1018); today's ceiling is the next UTC midnight plus skew.
   Cost invariant: a change to a principal's ceiling or to a policy costs on
   the order of that principal's grants and touches no key; a key holds its
   authority through its principal (in Hilt's model, a principal is an
   identity the tenant delegates to and revokes from). A bucket's deletion
   removes it from every policy by subject, which Hilt already does.
6. Vocabulary. Principals and policies cross the Management API in the
   contract's `s3:*` vocabulary through the existing mapping
   (`orchestrator/orchestrator.ts:506-525`); read-back maps to console
   permissions by the inverse (`read` when `s3:GetObject` is present, `list`
   when `s3:ListBucket`). Every principal holds `s3:ListAllMyBuckets`.
   Bucket-configuration reads are authorized by `s3:ListBucket` and writes by
   `s3:CreateBucket`, which is how Hilt classifies a GET or PUT on a bucket
   with no key (fil-forge/hilt `pkg/rpc/service/auth/operation.go:119-147`), so the two
   console bucket-info permissions map to `s3:ListBucket` on Forge; issuance
   drops them with a warning today (`orchestrator.ts:513-514`, `:534-538`).
   The contract enum
   (`management-openapi.yaml:532-549`) gains `s3:AbortMultipartUpload` and
   `s3:ListMultipartUploadParts`, which Hilt already accepts
   (fil-forge/hilt `pkg/s3perm/s3perm.go:58-59`; the gap is recorded in
   `2026-08-multipart-upload-permissions.md`).
7. Tenant identity per (org, region) is the console's to supply: when one
   network serves two regions for one org, the Forge implementation sends a
   region-qualified external id, and Hilt's one-provider-per-tenant model
   holds without a change
   ([§6](#6-membership-and-policy-lifecycle-on-iam-regions)).
8. Bucket lifecycle events remain an ask ([Open questions](#open-questions)); a
   management-API bucket-create with policy join is optional
   ([§7](#7-bucket-lifecycle-stays-on-keys-as-the-role-permits)).

ListBuckets stays a tenant-wide name listing
([§8](#8-what-a-member-can-still-see)) and is not a requirement either way.
Customer keys in a Forge region are retired when the region moves to the IAM
model: deleted at Hilt and in `UserInfoTable`, their creators emailed with a
variant of the notice of [§2](#2-the-scoped-key-model) that names the region's
move to the IAM model in place of a role change. The `filone-console` key
stays under the tenant-scoped shape.

### 12. Rollout

Merges to `main` auto-deploy to production, so every PR is independently
production-safe and a migration ships as a script-only PR before any PR that
depends on it, M1's standing rule. The order, with what each step changes on
merge:

1. The `accessModel` discriminant and the interface split, with all four
   regions declaring `'scoped-keys'`. No behavior change.
2. Role-narrowing revocation ([§2](#2-the-scoped-key-model)) with the preview
   route, the dialogs, the email, and the audit shape. Visible in every
   multi-member org in every region the day it merges; the rollout revokes
   nothing by itself, and a key is revoked only by a later narrowing that
   leaves it above the new role.
3. The IAM console surfaces ([§3](#3-what-a-bucket-policy-is)),
   `policies.manage`, and the IAM fake. Dark, because no region declares
   `'iam'`.
4. The per-network flip when a Hilt network ships the contract. Retire that
   network's customer keys (script-only PR first), keep `filone-console` under
   the tenant-scoped shape, write principals for existing members through the
   provisioning sweep or first use, then change the registry entry.
   `eu-central-3` and `us-east-9` flip on their own schedules. After the flip,
   Hilt availability gates membership writes for orgs with a tenant on that
   network, by design.

## Options considered

**Console-enforced policies on every region, with keys minted from one
policy.** It gives one product on three backends, straightforward enforcement,
and no key that over-grants, because a key takes all or part of one policy's
permissions and buckets and the vendor primitive carries that exactly. It ties
the key to a rule rather than to the person: a member with several policies
holds several credentials where an AWS customer expects one, a role change
strands policy-minted keys like any other so member-level revocation is needed
anyway, and the console masks a difference the backends cannot honor.

**Member-synthesized keys over a shared policy store behind the interface, with
revoke-and-reissue on narrowing.** It gives one key model everywhere, AWS-shaped,
with the store an implementation detail three regions share and one retires. On
a backend whose key is one flat permission set over a bucket array, a member
with read on one bucket and write on another gets a key that writes both; every
narrowing reissues credentials and breaks clients; and the store exists only to
imitate what one backend does natively.

**A grant per member and bucket**, one row keyed `(member, bucket)`, gives the
request path an O(1) read and needs no union and no versioning, and gives no
rule an admin can edit once: twelve members sharing eight buckets are ninety-six
rows with no name and no shape, and adding a bucket to the team is twelve
edits. **Materialized grant rows** beneath policies keep both and rule
themselves out by write amplification: a policy holding 50 buckets with 20
members is 1,000 projection rows on every edit, each a chance to drift from the
source of truth. **One policy per bucket**, which is what S3 means by the term,
makes an admin granting a team eight buckets write eight policies with eight
identical rosters. **Intersection instead of union** across overlapping
policies would let an admin narrow somebody by adding them to a restrictive
policy, and adding a member to a read-only policy would silently remove a write
they already had, the opposite of what an admin adding a grant expects.
**Withholding `s3:ListAllMyBuckets`** from a scoped member's keys refuses
enumeration whatever the gateway does, at the cost of the command outright:
`aws s3 ls` answers `AccessDenied` and tooling that enumerates before it acts
breaks, and Aurora always grants the action inside its `Default` access type
(`aurora-portal.ts:107`; `docs/S3Considerations.md:350`), so it cannot be
withheld there.

**Bucket lifecycle off every customer key.** Every creation and deletion is
then observed and audited, uniform across regions, and Aurora already works
this way. Its enforcement purpose would be a policy join on console-held
policy rows, which this design does not keep
([§4](#4-resolving-access-on-a-request)); the observation purpose is real and
[§7](#7-bucket-lifecycle-stays-on-keys-as-the-role-permits) gives it up; and
the change would cost `aws s3 mb`, the S3 compatibility suites, and every
existing FTH key carrying the two permissions, which neither FTH nor Forge can
narrow in place.

**Per-member FTH storage users.** FTH is the one vendor with a user object, and
keys already hang off a storage user, today one console-owned storage user per
tenant (`fth-orchestrator.ts:449-452`; `fth-tenant-setup.ts:106-114`). FTH
keys would still carry their own permissions and nothing would follow the
member live; it is the scoped-key model under a second name.

**A vendor ask to Aurora and FTH for policies and key update, with the union
over-granted on their keys until it lands**, the parity path. It keeps one
product on three backends behind one interface shaped after IAM. The interim
is the over-grant the member-synthesized option rules out, a key that writes a
bucket its member may only read, with no date on which it ends; and the ask is
a roadmap dependency on two third-party vendors, the fork the enforceability
memo names, decided toward Forge-first.

**Per-key retention on a narrowing**, an opt-out in the confirmation dialog:
on a scoped-key region nothing evaluates a retained key live, so it is a
standing over-grant ([§2](#2-the-scoped-key-model)).

## Open questions

1. **The staleness bound at the Forge gateway** for principal and policy
   changes (FIL-1018). Today's ceiling is the next UTC midnight plus skew, and
   during a Hilt outage console reads for a scoped member fail closed while
   warm keys keep working ([§5](#5-access-keys-belong-to-a-member)).
2. **Should the console act as the member on Forge**, with a per-member
   console credential, rather than sign with `filone-console`? That would put
   console traffic under the same principal the member's keys use. M3,
   FIL-1025.
3. **Bucket lifecycle observation.** A lifecycle feed from an orchestrator.
   Forge: Hilt emits debug logs only on create and delete (fil-forge/hilt
   `pkg/rpc/service/bucket/service.go:216`, `:267`), and authority is already
   withdrawn by subject on delete, so the gap is audit-only. FTH: a vendor ask.
   Aurora: portal-only, never exposed.
4. **FIL-1017's ListBuckets criterion.** Relax it, or reopen fil-forge/hilt#48,
   a change to a system Forge owns.
5. **Narrow service credentials on IAM regions.** A member-bound key carries
   the member's whole access, so a read-only credential for one app loses its
   current home there. AWS's answer is an IAM user per workload; the PRD rules
   service accounts out of scope.
6. **Prefix scope**: an IAM-model capability, Forge-only, which the per-region
   matrix can disclose (FIL-1018).
7. **The retry surface after a partially failed multi-region revocation.** The
   per-key events make the state visible and the surface is the same PATCH;
   whether an operator view is needed on top is unwritten.
8. **Milestone cut and GA dependency.** Bucket policies ship when a Forge
   network implements the contract and a Forge region reaches production; the
   console work proceeds against the IAM fake. The milestone cut is decided in
   Linear.

## References

- Tickets: FIL-1017 member bucket scope; FIL-1018 revocation timing and prefix
  scope; FIL-1019 privileged operations (the bucket-lifecycle half is reopened
  here); FIL-1020 legacy key transition; FIL-1021 member removal with key
  review; FIL-1022 audit viewer; FIL-1024 per-region capability disclosure;
  FIL-1025 M3 direct-key enforcement; FIL-918 Forge key update; FIL-949
  request-level logging.
- [`2026-08-organizations-roles-m1.md`](./2026-08-organizations-roles-m1.md)
  for roles, the permission registry, the creator cap, the audit write path,
  and the script-only-PR rule this design follows.
- [`2026-08-multipart-upload-permissions.md`](./2026-08-multipart-upload-permissions.md)
  for the contract enum gap and the console key's rotate-and-prune lifecycle.
- `docs/service-orchestrator-integration/management-openapi.yaml`, the
  Management API contract the IAM revision lands in.
- Staging measurement, 2026-08-26: out-of-scope object reads and `ListBuckets`
  behavior on Aurora and FTH. Forge behavior is from the Hilt and Ingot code
  cited in [§11](#11-the-iam-contract-for-forge).
- The enforceability memo, `iam-prd-enforceability-by-backend.md`
  (2026-08-11): the source of the "lead where we control the stack" path. It
  is not yet checked in to the knowledge-base repo.
- PR #642 discussion and the 2026-09-01 decision.
