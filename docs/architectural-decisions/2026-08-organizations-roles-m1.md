# ADR: Organizations, membership, and roles (IAM M1)

**Status:** Accepted
**Created:** 2026-08-14
**Implementation:** The PRs stacked above this ADR's own PR (#596) ship it: #597–#610 plus the close-out #617, with #626 and #627 carrying the deletion integration and #629 the handler-test-helper split, under stack #630. File paths below name modules as they exist at the top of that stack.

## Context

M1 turns every account into an organization and makes membership real. The requirements, from the IAM PRD and the M1 tickets:

- Every existing account becomes a single-member organization, converted in place with zero customer-visible change (FIL-1013).
- One identity can belong to multiple organizations, with a console switcher; the personal org coexists with invited memberships (FIL-1013). Multi-org is the point of the milestone: accepting an invitation is what creates the second membership.
- Four fixed roles (Owner, Admin, Member, ReadOnly) with a capability matrix from PRD §5.2, enforced identically in console and API (FIL-1015). At least one Owner always exists, and role changes take effect immediately at the control plane.
- Owner or Admin invites by email; invitations are revocable, expire after 14 days, and never touch billing (FIL-1014).
- Every membership and ownership change lands in an audit log (FIL-1015).

The Linear project _Identity & Access Management_ delivers the PRD in three milestones, and this ADR is the implementation design for the first, **M1: Organizations and roles** — the control-plane release, governing the console and API where FilOne mediates every request. M2 adds bucket scoping, key management, privileged-operation grants, the legacy-key transition, and the audit viewer. M3 is data-plane enforcement: applying roles to raw S3 traffic, on Forge (the in-house storage backend; the other two backends, Aurora and FTH, are third-party vendors). The M1 tickets: FIL-1013 organizations and in-place conversion, FIL-1014 invitations, FIL-1015 roles and the capability matrix, FIL-1016 harvest of orgauthaudit (an exploratory RBAC build this design lifts patterns from), FIL-920 role on `MeResponse`.

**Spec baseline.** The PRD Google Doc shows the August 5 draft. The review thread that followed it (#filone-general, the same week) changed three things:

1. The Billing role is cut, leaving four roles: Owner, Admin, Member, ReadOnly. The M1 tickets already encode this.
2. Privileged-permission grants become Owner-only.
3. Audit-log visibility becomes Admin-and-above.

This ADR designs for four roles. The matrix in §2 assigns the deleted Billing column's capabilities to Owner and Admin; the PRD revision should confirm that split (Open questions, item 1).

**What exists in code today.** The org schema half-exists and is entirely unenforced:

- **First login already writes org rows.** One `TransactWriteItems` writes four rows (`packages/backend/src/middleware/auth.ts:344-401`): `SUB#{sub}/IDENTITY`, `USER#{userId}/PROFILE`, `ORG#{orgId}/PROFILE`, and `ORG#{orgId}/MEMBER#{userId}` with `role: OrgRole.Admin`. The membership row and the `OrgRole` enum (`packages/shared/src/api/org.ts:3-6`) are written once and read by nothing. No role check of any kind exists on `main`; the first is arriving in the unmerged FIL-112 deletion stack (§2). Some early identities may lack a `MEMBER#` row entirely, because the membership write was added a few days after the earliest accounts and a signup-flow rework (#306) later removed a confirmation step; the conversion script (§7) counts and repairs that cohort before enforcement ships.
- **Identity is single-org.** `SUB#{sub}/IDENTITY` holds exactly one `orgId`, and no request carries an org selector. `UserInfo` (`packages/backend/src/lib/user-context.ts:3-11`) and `MeResponse` (`packages/shared/src/api/me.ts:4-20`) carry no role.
- **Billing is keyed per user.** `BillingTable`'s pk is `CUSTOMER#{userId}` while every resource is org-keyed. `subscriptionGuardMiddleware` reads the _calling user's_ row (`middleware/subscription-guard.ts:47-48`), so the moment an org has a second member, that member has no billing row and the guard locks them out of the whole product. `CUSTOMER#` appears at key sites across a dozen backend files, including five in `stripe-webhook.ts` plus the `resolveOrgIdFromSubscription` helper (`lib/deleted-customer-cleanup.ts:15-32`) that derives the org _by reading_ the `CUSTOMER#` row. Multiple `CUSTOMER#` rows can share one `orgId` (re-subscription after cancellation; `jobs/subscription-drift-checker.ts:72-75`), and rows with no `orgId` attribute exist; the jobs defensively skip them.
- **The backend cannot send email.** SendGrid is configured as the Auth0 tenant's email provider at deploy time (`jobs/stack-setup/setup-integrations.ts:289-310`); no request-path Lambda has a mailer, and the `SendGridApiKey` secret exists only on staging and production stages (`sst.config.ts:70`).
- **Persistence is DynamoDB with no indexes and no migration framework.** Three pk/sk tables (`sst.config.ts:93-123`), no GSIs anywhere. The house patterns: inverse lookup items in place of indexes — a second row keyed by the value you need to search by, written in the same transaction as the row it mirrors (`lib/rag-api-keys.ts:16-25`); one-off `bin/` scripts under `sst shell` for backfills (`bin/backfill-access-key-granular-permissions.ts` is the runbook); and lazy read-path upgrades.
- **The API is one Lambda per route.** 38 routes registered via `addRoute` (`sst.config.ts:616-950`), Middy middleware chains composed per handler, `ApiErrorCode` as the shared error vocabulary, and `apiRequest()` in the console interpreting those codes centrally (`packages/website/src/lib/api.ts:44-125`).
- **The trial entitlement is the system's only uniqueness constraint.** One free trial per email address, ever: a conditional put on `EMAIL_NORM#{normalizedEmail}` (`lib/trial-entitlement.ts:41-51`), claimed on the login path at two sites (`auth.ts:290-291` for existing users, `auth.ts:308` for new users) and lazily by the subscription guard (`subscription-guard.ts:56`), append-only, never released.

Two documents disagree with the code and get corrected as part of this work. `docs/AuthOverview.md` cites an "RBAC (Planned)" ADR section that does not exist and claims the data layout needs no migration for multi-member orgs (true for `UserInfoTable`, false for `BillingTable`). `docs/Authentication.md` is the historical provider bake-off rather than current state.

**The honest limit of M1.** Console roles do not constrain the S3 data plane. Anyone holding a SigV4 access key has that key's authority regardless of role, and existing keys carry most of the account's authority. M1 therefore governs the console surface, caps what new keys a member can mint (§2), and records who creates keys. Narrowing existing keys is the M2 legacy transition (FIL-1020), and request-time enforcement on Forge is M3.

Two consequences are worth stating plainly. Presigned URLs the console has already issued keep their authority until they expire, so presign lifetime — currently up to 7 days for downloads (`handlers/presign.ts:40`) — is the real revocation bound for object operations after a role change. And tenant suspension is per-org at the storage vendor, so "suspend one member" is expressible only as console denial plus key revocation.

## Decision

Four decisions carry the design:

1. **Organizations stay FilOne-native in DynamoDB.** The existing `orgId` remains the unit of tenancy, and the new org rows live in their own domain table, `OrgTable`. Auth0 Organizations arrive at SSO time, one per enterprise customer, never per account.
2. **Every authenticated request resolves its role by reading the membership row**, for an active org selected per request by an `X-Org-Id` header.
3. **Authorization is a static four-role permission registry** enforced by fail-closed middleware. No policy engine.
4. **The subscription record re-keys from the user to the org**, so membership in an org means riding that org's billing.

The alternatives each of these beat are recorded in Options considered, after the mechanics. The subsections below specify the mechanics.

### 1. Data model

All new rows follow the house convention: a TypeScript interface whose doc comment names the table and key shape, and a frozen key-builder object (`RAGKeys` pattern, `lib/dynamo-records.ts:181-212`) instead of inlined template strings. The four row types below live in a new **`OrgTable`**, declared in `sst.config.ts` beside the existing three tables. Audit events get their own table (§6). Nothing new lands in `UserInfoTable`.

| pk                            | sk                   | Attributes                                                                    | Purpose                                                |
| ----------------------------- | -------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| `ORG#{orgId}`                 | `MEMBER#{userId}`    | `role`, `joinedAt`, `source`, `invitedBy?`                                    | moves from `UserInfoTable` (§7); becomes authoritative |
| `USER#{userId}`               | `MEMBERSHIP#{orgId}` | `role` (denormalized), `joinedAt`                                             | inverse item: list a user's orgs                       |
| `ORG#{orgId}`                 | `INVITE#{inviteId}`  | `email`, `emailNorm`, `role`, `invitedBy`, `status`, `createdAt`, `expiresAt` | canonical invitation                                   |
| `INVITETOKEN#{sha256(token)}` | `LOOKUP`             | `orgId`, `inviteId`                                                           | accept-by-token lookup                                 |

Membership mutations keep the canonical row and the inverse item consistent by writing both in one `TransactWriteItems` — on create, on delete, and on every role change — so `MeResponse.memberships` can never show a role the user no longer holds. Role changes carry `ConditionExpression: role = :expectedRole` on the `MEMBER#` item, which makes concurrent conflicting changes lose cleanly instead of double-applying.

**The last-Owner invariant** lives in `OrgTable` as `ownerCount` on an `ORG#{orgId}/META` row owned by the membership module, so every owner-set transaction is single-table and the counter sits beside the rows it counts. `createNewUserAndOrg` writes `ownerCount: 1` from day one of this work, so no org is ever created without it. Every transaction that changes the set of Owners carries the counter delta as a single `UpdateItem` inside the transaction, with the guard expressed as that update's own condition (`SET ownerCount = ownerCount - :one`, `ConditionExpression: ownerCount > :one`). DynamoDB permits only one operation per item per transaction, so the check and the decrement must be the same operation. The operations and their deltas:

- accept of an Owner invitation: +1
- promotion to Owner: +1
- demotion from Owner: −1, guarded
- removal of an Owner: −1, guarded
- ownership transfer: ±0 — promote and demote in one transaction, touching the counter row once with a net-zero update that the transaction ties to the _new_ Owner's membership write

A periodic recount in the drift-checker pattern (`jobs/`) repairs divergence, since a counter with no reconciliation path eventually lies.

Access-key rows gain `createdBy` / `creatorEmail` and a `policyVersion` marker at creation (`handlers/create-access-key.ts:87-105`), copying the RAG-key shape (`lib/rag-api-keys.ts:37-38`); membership rows carry `source` (`signup`, `conversion`, `invitation` — the vocabulary SCIM later extends). These attributes are un-backfillable: a key created before the column exists has no owner forever, and a key minted between M1's roles and M2's member bucket scope is exactly the cohort FIL-1017's non-conforming-key review and FIL-1020's relabeling need to find. So they ship in the first PR, even though most of the UX that consumes them is M2.

For SSO-time adoption (Options considered), `ORG#{orgId}/PROFILE` reserves an optional `auth0OrgId` and the key builder reserves `AUTH0ORG#{auth0OrgId}/LOOKUP`; nothing writes either in M1, and reserving them now means adoption changes no schema.

`orgId` stays a UUID. `RAGKeys.parseBucketPk` depends on org ids containing no `#` (`lib/dynamo-records.ts:187-206`), and the `X-Org-Id` header value is validated as a UUID before it touches a key expression.

### 2. Roles and the permission registry

`OrgRole` becomes four values: `owner`, `admin`, `member`, `readonly`. The legacy stored value (the `admin` every first login has been writing) never enters `OrgTable`: the first PR's write path records new signups as `owner` there, and the conversion (§7) converts roles as it moves rows. In the window before the conversion completes, an absent `OrgTable` row resolves to Owner, which is safe because every pre-conversion account is an org of one. The default is applied in `authMiddleware`, never in the data layer: the read helpers report absence honestly, because the invite and removal paths built on them must treat absence as denial. Enforcement ships only in the following PR, after the conversion is verified, with the fallback removed.

Permissions are a string-literal union in `packages/shared/src/permissions.ts`, with the role table as `as const` data. The matrix is [PRD §5.2](https://docs.google.com/document/d/19zoGbN6EAHkxFbRKa2MlajcPS_GnpuL4lAnBU9kZX3Y/) as written, with the deleted Billing column folded into Owner and Admin (Spec baseline, above). One provenance note: the PRD names two canonical privileged operations, bucket deletion and retention bypass. That is why `buckets.delete` sits at Admin-and-above rather than with the everyday Member verbs, and why the retention pair is stricter still (below).

| Permission                                                                    | Owner | Admin | Member | ReadOnly |
| ----------------------------------------------------------------------------- | ----- | ----- | ------ | -------- |
| `members.read`                                                                | ✓     | ✓     | ✓      | ✓        |
| `members.manage` (invite, role changes, removal — targets at Admin and below) | ✓     | ✓     |        |          |
| `owners.manage` (promote to Owner, demote or remove an Owner)                 | ✓     |       |        |          |
| `org.rename`                                                                  | ✓     | ✓     |        |          |
| `org.transfer`, `org.delete`                                                  | ✓     |       |        |          |
| `billing.manage` (payment methods, portal, activation)                        | ✓     |       |        |          |
| `billing.view` (usage, invoices)                                              | ✓     | ✓     |        |          |
| `buckets.read`                                                                | ✓     | ✓     | ✓      | ✓        |
| `buckets.create`                                                              | ✓     | ✓     | ✓      |          |
| `buckets.delete`                                                              | ✓     | ✓     |        |          |
| `objects.read` (view, download, read presigns)                                | ✓     | ✓     | ✓      | ✓        |
| `objects.write` / `objects.delete` (console/presign)                          | ✓     | ✓     | ✓      |          |
| `keys.create`, `keys.manage_own`                                              | ✓     | ✓     | ✓      |          |
| `keys.manage_all`                                                             | ✓     | ✓     |        |          |
| `audit.view` (M2 viewer)                                                      | ✓     | ✓     |        |          |
| `privileged.grant` (M2)                                                       | ✓     |       |        |          |

`members.manage` is a ceiling on the _target_, and removal counts: an Admin can invite, change, or remove members whose role is Admin or below, and cannot touch an Owner by any verb. Removing an Owner routes through `owners.manage` exactly like demoting one; otherwise deletion reaches what demotion forbids.

`keys.manage_own` is the same shape one level down: the route permission says a Member may reach the list and delete routes, and it cannot say which rows on those routes are theirs. The handlers narrow it, comparing the caller against the key row's `createdBy` (`lib/key-scope.ts`) on both key kinds and on the activity feed, so a caller holding only `keys.manage_own` sees and revokes the keys they created and no others.

A row naming no creator is claimable by nobody: keys minted before attribution shipped are visible and revocable only under `keys.manage_all`, which keeps a Member from revoking what may be the org's rather than theirs. A recovered row — one reconciliation wrote after finding a key at the vendor with no local record — is the same case wearing an attribution: reconciliation can tell that a key exists at the vendor without being able to tell who asked for it, so the `createdBy` it writes is the best available guess rather than a fact. Recovered rows therefore stay `manage_all`-only too; the attribution is there to give an operator a thread to pull, not to hand a Member authority over a key that may not be theirs.

**Key creation is capped at the creator's authority.** Without this cap the console matrix is cosmetic: a Member denied `buckets.delete` in the console mints a key and does it over S3 instead. The member-scope cap check is one of the orgauthaudit pieces FIL-1016 lifts, and it splits across milestones: the _permission_ half ships in M1, the _bucket-scope_ half waits for M2 (member bucket scope does not exist until FIL-1017). Concretely, `create-access-key` refuses any requested key permission the creator does not already hold in the console, matching each to the console permission that grants the same capability:

- `read`, `list` → `objects.read`
- `write` → `objects.write`
- `delete` → `objects.delete`
- `CreateBucket` → `buckets.create`
- `DeleteBucket` → `buckets.delete`
- the bucket-configuration reads, `GetBucketVersioning` and `GetBucketObjectLockConfiguration` → `buckets.read`

A ReadOnly member cannot mint keys at all (`keys.create` denied). Matching a capability to something stricter than its console equivalent would be wrong in the other direction: it would refuse a Member the bucket creation they do every day. The cap governs what our console will issue; what the providers' key vocabularies can express per operation is the M2/M3 enforcement story.

The granular data-protection permissions — the finer-grained key permissions the schema nests under a selected object permission, retention and legal-hold reads and writes among them — ride the same cap without a second table of their own: each granular's requirement is its parent's requirement. The two mutating ones are the exception. `PutObjectRetention` and `PutObjectLegalHold` require `privileged.grant`, which only an Owner holds. They sit in the PRD's privileged class beside retention bypass, the review thread made privileged grants Owner-only, and the operational reason is theirs alone: both are redeemed at the vendor where their use cannot be audit-logged, and both can make an object undeletable for years. M2's privileged-operation flow (FIL-1019) replaces the blanket elevation with an explicit per-operation grant, off by default and conferred only by Owners.

**Enforcement** is `authorize(permission)` in `packages/backend/src/middleware/authorize.ts`, installed immediately after `authMiddleware()` and before `subscriptionGuardMiddleware()` in every authenticated handler chain. `authorize` fails closed: no membership row, unknown role, or missing permission each produce a 403. Placing it before the subscription guard means a non-member gets an authorization error rather than a billing error, and skips a `BillingTable` read on requests that will be denied.

`authMiddleware` resolves the membership row for the active org and exposes the row itself on `event.requestContext.userInfo` — the house channel for middleware-to-handler data (`lib/user-context.ts`), which in-handler checks can also read (`request.internal` is invisible to handlers, so it is not used for this). Exposing the row rather than a flattened permission list matters twice. `permissionsForRole` is a table lookup, so a permission set cached beside the row would be a second copy of derived state that can disagree with it; the one place a list is materialized is `GET /api/me`, which hands it to the console. And it matters for M2: FIL-1017 puts member bucket scope on the same row, and its consumers (presign, ListBuckets) then read it with no new plumbing.

Two new `ApiErrorCode`s (`FORBIDDEN_ROLE`, `NOT_A_MEMBER`) join the enum in `packages/shared/src/api/coreInterfaces.ts`, with matching branches in `apiRequest()` so denials render as intent rather than a generic toast, and a metric on the `NOT_A_MEMBER` branch so an unexpected lockout is visible in minutes rather than via support ticket.

**Routes declare what they require.** A route's category is one axis and its requirement is another, both declared in the manifest rather than implied. The four categories:

- _authenticated_ — carries a requirement (below)
- _public_ — the auth routes
- _webhook_ — `POST /api/stripe/webhook`: no Middy chain, Stripe-signature auth
- _bearer_ — `POST /api/buckets/{name}/query`: `ragQueryAuthMiddleware` bypasses `authMiddleware` entirely on the bearer branch (`middleware/rag-query-auth.ts:116-127`), so that path resolves `ORG#{record.orgId}/MEMBER#{record.createdBy}` itself and fails closed if the creator's membership is gone. Bearer requests get a real role instead of a permanent free pass, and a bearer request that also carries `X-Org-Id` is rejected: the key's org is the org.

An authenticated route's requirement is a permission, or `self`, or `in-handler`, or `invite-token`:

- `self` is the caller's own account, carrying no org gate at all. A role check on your own name and email would lock a ReadOnly member out of their own profile, and a membership check would lock out the user whose missing membership row is what went wrong. This is also why the org's name does not travel in the profile body: renaming the org is its own route, `PATCH /api/org` under `org.rename`, while `PATCH /api/me/profile` carries name and email alone, so no route has to declare one requirement for a user-scoped field and an org-scoped one.
- `in-handler` is the requirement a route cannot state because it depends on the body. `POST /api/presign` serves several operations through one route, so its permission check runs in-handler against the same registry, branching read/write/delete per requested operation next to the existing trial checks (`handlers/presign.ts:195-210`); a batch containing any denied operation is rejected whole, with the denial code naming the operation. Mutating retention and legal-hold presign operations are privileged from M1 — none exist in the presign vocabulary today, and adding one behind a general permission would hand M2 a capability to claw back, since a presigned URL is redeemed at the vendor and its use cannot be audit-logged per FIL-1019. `getObjectRetention` is a read of retention state, which the PRD's auditor path grants, and maps to `objects.read`.
- `invite-token` marks the single route whose caller is by definition not yet a member of the org it acts on: accepting an invitation, authorized by the token in the body plus a session whose verified email is the invited address, both checked in the handler. Accepting cannot be `self`, because `self` is for routes that touch no org state, and accepting creates a membership.

Completeness is machine-checked, in the spirit of orgauthaudit's registry and route CI checks: a manifest in `packages/shared` lists every route with its category and requirement, and `sst.config.ts` registers the API's routes by iterating it, so a route with no manifest entry does not deploy. Compliance suites derived from the manifest prove every route by behavior: gated routes answer 403 per denied role, session routes answer 401 to a request carrying no credentials, open routes pin their unauthenticated answers, and the self, bearer, in-handler, and token-proof categories are driven to the semantics they declare — enforcement tests a new route gets by declaring itself. No test reads handler source; a route missing entirely is the integration suite's to notice.

`MeResponse` gains `userId`, `role`, and `permissions: Permission[]`, following the `ragAccess` precedent of shipping a server-computed decision to the SPA. The console gates rendering on it fail-closed, copying `use-rag-access.ts:16-23` plus the pending/error guard from `BucketIntelligencePage.tsx:29-37`, with a `RequirePermission` wrapper for destructive surfaces. Server-side checks remain the enforcement; the UI only hides what will not work.

**Step-up MFA** on destructive org actions follows the FIL-112 stack's `requireMfaIfEnrolled` variant rather than plain `requireMfa`, because for a user with no MFA enrolled an unsatisfiable `amr` check would block the action outright. It applies to ownership transfer in M1, with one correction that decides whether the gate survives FIL-945's security review: for a SAML user, `amr` (the token's authentication-methods claim) never contains the MFA markers (`mfa`, `phr`) and Auth0's Guardian MFA has no enrollment, so the variant as written passes them silently. The step-up redirect therefore sends `max_age=0` and the gate reads `auth_time` alongside `amr`, making "recently re-authenticated at the IdP" the SSO-era step-up signal. `buildAuth0AuthorizeUrl` gains the `max_age` and (reserved, unused in M1) `organization` parameters in the same change, since a step-up round trip must never be the place org context silently drops. A second SSO-forward guard lands with it: the verified-email gate (`auth.ts:473`, default-on) becomes connection-aware via the existing `getConnectionType`, because a federated identity's remedy can never be an Auth0 verification email.

**Coordination with the FIL-112 deletion stack**, which merged first (`2026-08-self-serve-account-deletion.md`). Its `isOrgAdmin()` gate — the codebase's first role check, reading the `UserInfoTable` `MEMBER#` row the conversion deletes — was patched onto `OrgTable` through the transition fallback in the same PR that creates the table, and folded into `authorize('org.delete')` when enforcement landed: both deletion routes sit in the manifest under `org.delete`, installed ahead of the MFA gate so a role the matrix refuses is denied outright rather than sent on a step-up round trip it would fail. Its scrubbed-row billing fence rides every subscription write as the store's `guardAgainstScrub`, and the session fence covers both orgs a request can be about: the identity row's org at sign-in, and the header-resolved active org where its membership standing is checked — without the second check, a member could keep operating in a deleting org by naming it in `X-Org-Id`.

**Account deletion in a multi-org world.** What the merged flow has not absorbed is this ADR's model of what an account is. FIL-112 shipped when every account was an org of one, so deleting "the account" deletes the org and every member's global identity in one motion: each member's Auth0 user, their email-keyed allowlist rows, their `SUB#`/`IDENTITY` tombstone and `USER#/PROFILE` stamp. One identity in many orgs makes those two different operations:

- **Deleting an organization** (`org.delete`, Owner-only) scrubs and destroys org rows: scrubs tenant data, destroys keys, invitations and their token lookups, deletes the org's Stripe customer and subscription, its membership rows and inverse items — and, only for a member whose sole membership is this org and whose personal org it is, the identity teardown FIL-112 already performs. Any other member keeps their login, their personal org, and their other memberships; deleting org B must not cost a member their identity.
- **Deleting a user account** (the self-serve flow, M2) is leaving every org, deleting the personal org, and then the identity teardown. An Owner whose departure would leave a multi-member org unowned is refused the way demotion is: transfer or delete the org first — the `ownerCount` invariant one level up.

Two sequencing facts make part of this M1 work rather than M2 polish. The teardown enumerates members from the `UserInfoTable` `MEMBER#` rows the conversion (§7) deletes, so the conversion silently hollows out the live Stripe-triggered teardown: it would resolve zero members and mark itself done. And the billing re-key (§5) moves the subscription off the per-member `CUSTOMER#` rows the teardown cancels. The integration therefore ships inside this stack, as two PRs slotted where the migrations force them: before the conversion runs, the teardown re-points member enumeration at `OrgTable`, applies the sole-membership census above, and scrubs the `OrgTable` rows nothing cleans today; with the flip, its Stripe step cancels the org's subscription and customer from the org row. Until invitations are enabled every org is still an org of one, so neither step changes observable behavior on the day it merges — the property that lets them slot into this sequence at all. One guard rides with invitations themselves: the accept transaction refuses a deleting org via the same profile-fence `ConditionCheck` the guarded writers use, so a membership cannot be born into a teardown that has already resolved its targets. Self-serve deletion stays dark behind its flag throughout (FIL-919); its console copy says "your account", which stays honest exactly as long as deletion reaches only orgs of one, and M2's flow re-words it when the split becomes user-visible.

### 3. Org context on every request

Multi-org membership (FIL-1013) needs a "which org is this request about" input that does not exist. **The active org travels as an `X-Org-Id` request header**, sent by `apiRequest()` on every call and validated server-side.

In `resolveUserAndOrg`: if the header is absent (curl, old clients), the active org is the identity row's `orgId` — the personal org, preserving today's behavior. If present, the middleware reads `ORG#{header}/MEMBER#{userId}`, the same read that resolves the role, and a missing row is a 403 `NOT_A_MEMBER`. `userInfo.orgId` becomes the active org, so every downstream handler, guard, and key expression stays untouched. Nothing about the token changes; a revoked membership dies on the next request. Because an absent header silently means "personal org", the console always sends the header, and `GET /api/me` echoes the org it actually served. Bearer requests never read the header: the RAG query route resolves its org from the key's `RAGKEYHASH#` lookup row (`middleware/rag-query-auth.ts`), so a key operates only in the org it was minted in, whatever header the caller sends.

`/api/me` is the one route that resolves the header leniently, because its response is what repairs a broken tab. A malformed value, an org the caller is no longer a member of, and an org this session may not enter all degrade to the identity row's org instead of refusing.

The console detects the repair through the echo: the served org disagrees with the stashed org id, so the console clears the stash and reloads. The reloaded request sends no header, so the recovery cannot loop, and a flag surviving the reload lets the page say what happened rather than presenting a switch that appears to have done nothing. A `/me` request that fails outright (not a header problem) drops the stash once per page load, and logout drops it too, so the next person to sign in on a shared machine does not start inside the previous user's org. Every other route stays fail-closed: a header naming an org with no membership row for the caller is a 403 `NOT_A_MEMBER`, and a malformed one is a 400.

Two infra facts gate this PR: `X-Org-Id` must join the API's CORS `allowHeaders` (`sst.config.ts:226` is an explicit allowlist, and local dev against a deployed stage is cross-origin), and the CloudFront distribution in front of `/api/*` must be verified to forward the header.

A header rather than a path segment because the 38 routes are not org-prefixed and re-pathing the API surface adds nothing; a header rather than a cookie so each request names its org explicitly instead of inheriting ambient state.

`MeResponse` gains `memberships: { orgId, orgName, role }[]` from the inverse items, with the active org always present in the list — synthesized during the conversion window when its inverse item does not yet exist — so `role` and `memberships` can never disagree about the org the caller is operating in.

**The console keeps the active org id in `sessionStorage`**, per-tab, like the step-up stash it already uses. A shared `localStorage` value would let a switch in one tab silently retarget another tab's requests, and a destructive click in a stale tab would land in the wrong org. Per-tab isolation is an implementation property, not a product commitment: org-scoped sessions at SSO time fix org context per browser session, and nothing in M1 promises multi-org tabs. One rule is also set now for that era: **once an org carries an `auth0OrgId`, a request naming it in `X-Org-Id` is rejected unless the session's `org_id` claim matches.** An org's Auth0-side connection restrictions and authentication policy must not be bypassable from a session authenticated elsewhere; that is the "enforcement, not just availability" line FIL-945's security review draws.

The switcher renders in the sidebar identity button (`SidebarNav.tsx`) and its mobile twin (`AppShell.tsx:11-77`), hidden when the user belongs to exactly one org (the `RegionSelect` disable-when-one-option ergonomic). **Switching does a full reload of the tab.** No TanStack Query key carries an org dimension today (`lib/query-client.ts:29-65`), and `/me` is cached under two keys with a 10-minute stale time; a reload is the mechanism that cannot leak org A's cache into org B's view. A soft switch (org id in every query key) is later polish.

Org surfaces stay invisible to solo users: the switcher renders on more than one membership, and the members nav entry and page render on more than one membership or the beta flag, which `GET /api/me` answers for the active org as `orgsBeta`. `members.read` cannot make that decision — all four roles hold it — so it stays the inner check on the page rather than the thing that decides the page exists. Reading the org's own member count or its pending invitations would gate the surface on a request only that surface makes, so those two conditions are deferred; a solo Owner in a beta org keeps the surface, which is the case that has to work, because somebody must be able to send the first invitation.

### 4. Invitations

Owner or Admin invites by email with a role at or below their management ceiling (Admins invite up to Admin; Owners can invite Owners). The handler writes the invitation row and its token-lookup item in one transaction, sends the email, and audit-logs the event. The email carries org name, inviter, and an accept URL with a single-use random token; the stored row keeps only the token's SHA-256. Invitations expire after 14 days, enforced by an `expiresAt` check at read time rather than a TTL delete, which would erase the record before the M2 audit export could see it. Revocation runs as a transaction too (`status = revoked` on the canonical row, token-lookup item deleted), so a revoke racing an accept produces a clean loser rather than a 500. Pending invitations per org are capped; the API has no rate limiting anywhere, and the cap is the cheap guard. Member removal, the other half of managing members, ships in its minimal M1 form and is specified with the audit write path (§6), whose transaction shape is its guarantee.

**Accepting.** The accept page is an SPA route in the shape of `/verify-email` (`routes/verify-email.tsx:9-18`). There is no `returnTo` plumbing in the auth flow — every login lands on `/dashboard` — so the page stashes the token in `sessionStorage` before bouncing through login and resumes after, exactly the step-up pattern (`lib/step-up.ts:18-31`); the resume runs in the router's `beforeLoad`, ahead of any data query.

The accept endpoint requires an authenticated session whose **verified email normalizes to the invitation's `emailNorm`** — the token alone must not admit whoever a forwarded email reaches. It then runs one transaction:

1. create the membership row and its inverse item;
2. mark the invitation accepted, with `ConditionExpression: status = :pending` — this condition, plus the transactional delete of the token-lookup item, is what makes the token single-use;
3. apply the `ownerCount` delta when the invited role is Owner;
4. re-check the _inviter's_ membership with a `ConditionCheck` — an invitation must not outlive its issuer's authority, so an Admin demoted after inviting cannot mint members through invitations still in flight (demotion and removal also revoke that member's pending invitations);
5. append the audit event.

Accepting when already a member is an idempotent success that still marks the invitation accepted. Expired, revoked, and never-existed tokens all return the same not-found response. An email mismatch returns its own `ApiErrorCode`: the caller already holds a valid token and an authenticated session, so this is no token-probing oracle, and under SSO it is the difference between a debuggable "signed in with the wrong account" and an opaque dead link. On success the console sets the active org to the new org and reloads.

The invitation record is transport-independent: the row and its lifecycle (create, revoke, the accept transaction) never reference the mailer, so an SSO-era switch to Auth0-delivered invitations replaces the send and the token and leaves the lifecycle — including the inviter re-check and `ownerCount` arithmetic — untouched.

**Trials and billing.** Invitations never touch billing, and the mechanism is removal rather than exception: **the two login-path entitlement claims (`auth.ts:290-291` and `:308`) are deleted**, leaving the subscription guard's lazy claim as the only claim point, and §5 confines that to the personal org. Trial creation thus happens on a user's first gated request _in their own org_. For an organic signup that is the dashboard's first API call, one request later than today with the same Stripe latency; for an invitee it never happens as a side effect of joining someone else's org. Each of these is pinned by a test:

- _An invitation never creates a trial._ Joining and acting in an inviting org performs no entitlement claim and no Stripe call.
- _An invitation does not resurrect suppressed eligibility_ (FIL-422): nothing in the invite or accept path reads or writes `EMAIL_NORM#` records. A member whose email lost the entitlement race still gets full member access, because membership plus the org's own subscription now govern org access (§5).
- _Accepting does not burn the invitee's claim._ The claim is spent if and when they first use their personal org, which is the intended semantics: it remains available, and it is theirs.

Invited users keep the current first-login behavior otherwise: a personal org is still auto-created — every account is an organization, and with the trial claim decoupled the auto-creation has no billing side effect. An org can hold members while its storage tenants are still lazy-unprovisioned; invite flows never read tenant ids.

### 5. Billing re-keyed to the organization

The subscription row moves from `CUSTOMER#{userId}/SUBSCRIPTION` to `ORG#{orgId}/SUBSCRIPTION` in `BillingTable`, whose `ORG#` partition already holds `USAGE_REPORT#` items — the shapes coexist. A copy-then-flip is not safe here: Stripe webhooks mutate subscription rows continuously, so a twin copied today is stale tomorrow, and the grace-period enforcer scans by `sk = SUBSCRIPTION` with no org dedupe (`jobs/grace-period-enforcer.ts:93`), which would process twins twice and parse garbage userIds out of `ORG#` pks. The transition is four phases:

The row, as the flip leaves it (`lib/dynamo-records.ts`):

| pk            | sk             | Attributes                                                                                                                                                                                                                                                             |
| ------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORG#{orgId}` | `SUBSCRIPTION` | `orgId` (required), `userId?` (the member who owns the Stripe customer), `stripeCustomerId?`, `subscriptionId?`, `subscriptionStatus?`, trial/grace/period timestamps, payment-method display fields, cached `stripePrice`, `deletedAt?` (the teardown's revive fence) |

`CUSTOMER#{userId}` remains only as the retained legacy copy until the runbook's dated cleanup.

1. **Dual-write.** One `readSubscription(orgId, userId)` helper replaces every direct read (both guard sites, the five billing handlers, `billing-activation`, `create-billing-trial`), reading the org key first with `CUSTOMER#` fallback; every writer writes both keys. The webhook is already halfway there: it reads `metadata.orgId` and backfills it onto billing rows (`orgIdBackfill`, `stripe-webhook.ts:174-183`), so the remaining work is keying its five `CUSTOMER#` writes to the org and re-pointing `resolveOrgIdFromSubscription` (`lib/deleted-customer-cleanup.ts:15-32`), which still finds the org _by reading_ the `CUSTOMER#` row. The Stripe idempotency keys in `create-billing-trial` re-key from `billing-trial-${userId}` (`create-billing-trial.ts:44,56`) to the org id, and the existence check re-keys with them — otherwise one human with two orgs gets one Stripe subscription silently shared between them, and usage from both orgs bills to one meter. That file's billing-row write is a deliberately unconditional update (a `customer.subscription.created` webhook can land first and upsert a partial row; `create-billing-trial.ts:60-67` documents it), and the re-key preserves that. The scan-driven jobs gain org dedupe and a filter that ignores legacy `CUSTOMER#` rows once their twin exists.
2. **Backfill** (`bin/` script, dry run first): copy each `CUSTOMER#` row to its org key using the row's `orgId` attribute. The dry run reports two counts before anything writes: rows whose `orgId` collides with another row's (re-subscription history — resolution rule: the row whose `subscriptionId` is live in Stripe wins, ties to newest `updatedAt`, conflicts halt and list) and rows with no `orgId` at all (reported for manual disposition; the jobs already skip them — the 20 known ones are FIL-906's orphans, whose cleanup runbook is their disposition, best run before this backfill so the dry run's report is already clean).
3. **Flip.** Remove the `CUSTOMER#` fallback from `readSubscription` and the dual-write from the writers; re-run the drift checker to reconcile anything a webhook touched mid-backfill.
4. **Delete** the `CUSTOMER#` rows as a dated runbook step, so the scans never see them again.

The Stripe side follows the same shape: **one Stripe customer per organization**, created at that org's first billing claim (the trial claim or the first setup intent) and stamped with `metadata.orgId`, plus the acting user's id for provenance. Individual members never get a Stripe customer of their own, whatever their role. This is what org-first webhook resolution rests on: an event's org comes from the metadata it carries, not from reading a row keyed by whichever human happened to click.

The `SubscriptionRecord` interface finally declares the `orgId` it has always written (`lib/dynamo-records.ts:14-32`). The dedupe logic in the drift checker and usage-reporting orchestrator becomes an invariant assertion once one-org-one-subscription holds. Delayed webhooks get guards on both identities:

- The destructive subscription-driven writes (the cancel-and-grace write, the payment-failure write-lock) skip when the stored row already names a different `subscriptionId`, so a delayed event from a subscription the org has since replaced cannot clobber the live row on either key. The payment-success write carries the same guard, because on the shared org row it is destructive in the other direction: a successful invoice from a replaced subscription would mark the org active and re-enable its tenants while the authoritative subscription is past due. `handleSubscriptionUpdate` keeps last-writer-wins, because it upserts and an upgrade legitimately arrives under a new subscription id.
- `customer.deleted` carries the same guard one identity up: the close-out compares the org row's stored `stripeCustomerId` against the customer the event names and skips, logged and metered, when they differ, so deleting a historical customer that still names the live org cannot disable the service the replacement subscription is paying for.

The guard's no-subscription branch changes meaning under org keys, and the rule is: **the lazy trial claim runs only when the active org is the caller's personal org and that is their sole membership**, enforced server-side (the header cannot be trusted to prove intent). A member acting in an org with no subscription row gets a billing-inactive denial naming the Owner as the person who can set up billing. Both halves of the rule earn their place. Without the personal-org restriction, the guard would spend a member's personal entitlement claim to create Stripe billing _on someone else's org_, anchoring org B's subscription to Alice's Stripe customer. Without the sole-membership condition, every enterprise employee who ever glances at their personal dashboard mints a Stripe trial nobody wanted. A member who later genuinely wants personal use activates billing explicitly; no trial is silently spent. A fourth pinned test covers it: a member of another org can never cause a billing write for that org.

Consequences that fall out correctly: an invited member's gated requests read the _active org's_ subscription, so they ride the org's existing trial or paid state — FIL-1014's criterion without special-casing. Ownership transfer changes role attributes and nothing in billing, since the subscription is keyed to the org and the Stripe customer is untouched. Seats stay free by construction: the subscription has one metered storage item and `quantity` is never set.

### 6. Audit write path

M1 ships the audit _write_ path; the viewer, export, and retention tooling are M2 (FIL-1022). Writing early gives the org history no gap once the viewer ships, and the 90-day TTL means events older than a quarter are gone whenever it arrives.

A new `AuditTable` in `sst.config.ts`: pk `ORG#{orgId}`, sk `{iso8601}#{eventId}`, TTL attribute stamped at append per the PRD's 90-day retention. Membership-change rates put a single partition per org nowhere near DynamoDB's per-partition write limits; the key derivation lives in one builder so sharding can be added without a data migration if that ever changes.

The event envelope follows orgauthaudit's shape — flat CloudEvents-style fields, a prohibited-content list, a redaction pass — and the actor is typed from the first event as `{ kind: 'user' | 'system' | 'connection', id, email? }` rather than a bare userId, so SSO/SCIM-era events (provisioning, deprovisioning, IdP logins) add an actor kind instead of a second schema the FIL-1022 viewer would reconcile forever. The M1 event types are defined against _this_ repo's registry rather than lifting orgauthaudit's taxonomy, which is generated from their 1,100-line permission registry and imports the exact vocabulary FIL-1016 says not to adopt. Left behind with it: Merkle roots, KMS signing, canonicalization, archive workers, and proof endpoints — the PRD asks for an append-only log, and the review thread dropped tamper-evidence from the claim.

Writes split by whether the mutation is ours alone. Pure-DynamoDB mutations (membership changes, role changes, invitations, org rename) go through a `commitAudited` helper: one `TransactWriteItems` spanning the mutation and a create-only event put, so the mutation cannot land unrecorded. An audit-table outage then blocks those control-plane writes; that is accepted over an audit log with holes. Mutations with an external side effect get a different guarantee, because the external call cannot join the transaction. `create-access-key` mints the credential at the storage vendor _before_ any local write, and a fail-closed local transaction after the fact would leave a live SigV4 key with no record, which is worse than a log hole. Those flows write an intent event before the external call and a completion event with the local row after it, correlated by id, so a crash between the two leaves a visible dangling intent instead of an invisible credential.

M1 event types: `org.created`, `org.renamed`, `org.logo_updated`, `member.invited`, `invite.revoked`, `invite.accepted`, `member.role_changed`, `member.removed`, `ownership.transferred`, `key.created` (intent/completion), `key.deleted` (intent/completion). Every FIL-1015 membership and ownership change lands here, ahead of the M2 viewer. `GET /api/activity` stays what it is — a synthesized convenience feed, never relabeled as audit.

`org.logo_updated` is `PATCH /api/org` recording a logo-only save distinctly from `org.renamed`, added when the Edit organization dialog grew an avatar picker: the same request can change the name, the logo, or both, and a logo-only save labeled `org.renamed` in a customer-facing log would say something that did not happen. When both change in the same save, the single `org.renamed` event carries the logo fields too (`logoUrl`/`previousLogoUrl`, optional) rather than a second event, since one save is one action.

Member removal itself ships in M1 as the minimal form the matrix implies: membership and inverse item deleted, audit-logged, pending invitations from the removed member revoked, keys untouched but listed in the confirmation dialog. FIL-1021 (M2) layers the revoke-keys-by-default flow with per-key review on top.

### 7. Conversion, beta flag, and rollout

**In-place conversion (FIL-1013)** is a backfill that doubles as the move into `OrgTable`. Every existing account is already an org-of-one in the data model; what changes is meaning and address. A `bin/` script (dry run, conditional writes, revert) does five things:

1. writes each org's `MEMBER#` row into `OrgTable`, with `owner` in place of the legacy `admin`;
2. **creates** rows for the early cohort that has none, from `ORG#{orgId}/PROFILE.createdBy`, with the dry run reporting the cohort's size;
3. writes the `USER#/MEMBERSHIP#` inverse items;
4. stamps `ownerCount: 1`;
5. deletes the dead `UserInfoTable` `MEMBER#` originals.

The role is rewritten once, by the script, as the row is copied. No read path maps `admin` to anything, so an `admin` in `OrgTable` is a real Admin — the role the invitation vocabulary hands out — and a row the invitation flow writes is never re-read as something else. Ordering keeps the two meanings from coexisting: invitations sit above enforcement in the stack, and enforcement merges only once the conversion has run and its counts verify, so the first invited Admin cannot exist while a legacy row remains. Until the conversion completes, membership reads treat an absent `OrgTable` row as Owner (§2).

Solo users see nothing: no new surfaces render for a single-member org without the flag, signup and first-upload flows are untouched, and billing conversion (§5) changes keys and leaves behavior alone.

**Beta flag.** Invite _creation_ gates on an allowlist row: `ALLOWLIST#{email}` with a new `ORGS_BETA` sort key, the mechanism `middleware/rag-access.ts:19-23` explicitly invites reusing — data-driven, no redeploy to grant. The read also checks `ORG#{orgId}/ORGS_BETA`, so a whole org can be enabled at once, which is the entity an enterprise beta actually wants and whose members' emails FilOne learns only at first login. Everything downstream of an invitation existing is unflagged: accepting requires no flag (the invitee's experience must not depend on their allowlist status), and org surfaces render from org state (§3), so a non-allowlisted Admin in a real multi-member org sees the members page without the invite button. Role _enforcement_ ships unflagged: every existing user is the sole Owner of their org once the conversion repairs the membership gaps, enforcement passes everything for Owners, and a second member can only arrive through the flagged invite path.

**Deployment reality.** Merges to `main` auto-deploy to production with no human gate, so every PR is independently production-safe, and a backfill can never ride in the PR that depends on it. The standing rule: **each migration ships as a script-only PR, gets run manually, and only then does a PR that depends on the migrated data — or removes a compatibility path — merge**, with the removal gated on a verified zero-count scan. The scripts resolve their table names from `sst state export` and talk to DynamoDB with the operator's ambient credentials — not `sst shell`, which cannot evaluate providers against production. The write-path changes that migrations depend on (new signups writing `owner` and `ownerCount`) land in the first PR, before any script runs, so nothing created mid-migration is born needing repair.

### Sequencing

Fifteen PRs ship above this one: #597–#610 plus the close-out #617. The plan called for thirteen stack items; two split in half during the build. The order:

1. **Foundations and scripts**: the enum, the `OrgTable` declaration, write-path changes, `createdBy`, the conversion script, the absent-row fallback, `MeResponse` exposure. The teardown's re-point at `OrgTable` (§2, deletion in a multi-org world) merges in this group too, because the conversion breaks the old enumeration the day it runs.
2. **Enforcement**: `authorize()` on all four route categories, error codes, console gating. Merges only after the conversion's counts verify.
3. **Audit write path and billing dual-write**, independent of each other, both after enforcement. The billing backfill, flip, and cleanup complete before invitations exist, because the first accepted invitation creates the first real second member. The teardown's org-keyed Stripe step (§2) rides with the flip, which deletes the per-member rows it cancels today.
4. **Org context** (CORS entry, header resolution, switcher), parallel to the billing chain.
5. **Invitations**, which need both org context and re-keyed billing; then the **members console**, which needs invitations.
6. **Close-out**: the destructive e2e specs (invite, role gating, switcher), end-to-end flag wiring, and the documentation corrections (`AuthOverview.md` rewritten to match what shipped, `Authentication.md` marked historical).

The billing chain is the critical path.

Ticket adjustments: FIL-920 is fully contained in the first two PRs and closes as absorbed by FIL-1015 (its acceptance criteria already say so). FIL-1016 gains acceptance criteria matching the kernel and audit PRs (registry, fail-closed middleware, manifest completeness test, key-permission cap, audit write path) in place of describing a harvest. FIL-1013 gains the billing re-key explicitly — it is that ticket's largest item, and its text never mentions billing beyond "changes nothing about billing". The FIL-112 stack coordination from §2 gets a comment on that ticket.

## Options considered

### Where organizations live: FilOne-native vs Auth0 Organizations

**Decision: organizations stay FilOne-native in DynamoDB; Auth0 Organizations arrive at SSO time, one per enterprise customer, never per account.**

`docs/AuthOverview.md:358` floats Auth0 Organizations as an open consideration ("potentially in the future"). The code has none of it: our `orgId` is a UUID minted at first login and baked into DynamoDB partition keys, Aurora/FTH tenant mappings, and SSM parameter paths, and Auth0 knows nothing about it.

Auth0 Organizations supplies real machinery: the invitation email rides the tenant's SendGrid provider, and per-org enabled connections plus `assign_membership_on_login` are the pieces enterprise SSO uses. But the invitation email is inseparable from org-scoped login — the invitation link's only target is `/authorize` with an `organization` parameter, and there is no acceptance webhook — so taking the email makes every user's login organization-aware. With one application that means the server must know a user's org before they authenticate, or every login gains Auth0's organization picker, whose "Continue with personal account" option cannot be suppressed; and switching orgs becomes a browser-wide re-authentication redirect. Auth0's own model is an organization per business customer, never per end user, and the plan tiers underline it: B2C tiers cap Organizations at 10 and include no enterprise connections at all, while the B2B plans SSO forces make Organizations unlimited.

So Auth0 remains pure authentication in M1. When the first SSO deal lands, that customer's Auth0 organization is created alongside its enterprise connection, its id stored on the org profile (`auth0OrgId`, schema reserved now, §1), and enterprise logins either pass `organization` through the existing authorize flow or use a second Auth0 application with `organization_usage: require`. That setting is per-application, so the self-serve login flow never changes; the cost is client selection at `/login` and a refresh exchange with the matching client. Membership lists are deliberately never mirrored: Auth0's member list (filled by `assign_membership_on_login`) means "may authenticate through this org's IdP," the `OrgTable` row means "is a member, with this role and scope," and only the local row is ever read for authorization, so drift between them is not an incident. Plain SAML needs none of this — the `connection` authorize parameter is already plumbed (`packages/shared/src/auth.ts:41`). What SSO does force is a plan question: enterprise connections are absent from B2C tiers and metered on B2B, which attaches to FIL-945 (Open questions, item 6).

### How a request learns its role: per-request read vs token claim vs denormalized identity row

**Decision: read the membership row per request.**

Putting the role in the JWT gives it a one-hour staleness window (access-token lifetime, `lib/response-builder.ts:14`) and collides with the deliberate fail-open refresh fallback (`auth.ts:552-562`). Denormalizing the role onto `SUB#{sub}/IDENTITY` breaks under multi-org, where the role depends on which org is active.

`authMiddleware` already does a DynamoDB `GetItem` for identity; it gains one more, for `ORG#{activeOrgId}/MEMBER#{userId}` in the new `OrgTable` (§1). Role and membership changes take effect on the next request, which satisfies FIL-1015's "immediately at the control plane" without invalidation machinery. The extra read lands on every authenticated request including the 12 provisioned-concurrency routes; it is one more `GetItem` in a middleware that already makes one.

### Authorization mechanism: static permission registry vs policy engine

**Decision: a static permission registry** — a typed permission union and a role-to-permission-set table in `packages/shared`, enforced by a fail-closed Middy middleware.

orgauthaudit ships a real Cedar WASM evaluator. Four fixed roles do not need one, and the PRD explicitly rejects customer-authored policy. The registry is the FIL-1016 directive, and it is also what orgauthaudit itself computes for its UI capabilities map without touching Cedar (`snapshot.ts:453-471`).

### Billing under multi-member orgs: re-key to the org vs billing-owner indirection

**Decision: re-key the subscription row to `ORG#{orgId}/SUBSCRIPTION`**, through a dual-write transition (§5).

Keeping `CUSTOMER#{userId}` and adding a `billingUserId` pointer on the org profile is less migration, but it leaves billing pinned to one human forever, adds a lookup hop on every gated request, and preserves the ambiguity the drift-checker and usage-reporting jobs already have to dedupe around. Re-keying makes one org, one subscription an invariant instead of a warning log, and §5's one-Stripe-customer-per-org follows the same shape.

### Data placement: widen `UserInfoTable` vs a new `OrgTable`

**Decision: M1's membership and invitation rows live in a new `OrgTable`. Separate entities live in separate tables.**

Single-table design is an AWS idiom, and its payoffs (heterogeneous item collections fetched together, GSIs overloaded across entity types) go unused in this codebase: every read is a point `GetItem` or a single-prefix `Query`, and there are no GSIs at all. What `UserInfoTable` has instead is identity mapping, user profiles, org rows, trial entitlements, RAG keys, and feature flags sharing one table with nothing joining them. Nothing here proposes a relational database; the data model should still read as entities, which is how the repo already keeps `BillingTable`, `RagIndexerTable`, and §6's `AuditTable` apart, with the single-table idiom applied inside each.

Membership moves now because it is the cheapest it will ever be: nothing reads the existing `MEMBER#` rows, so the conversion writes them into the new table instead of rewriting them in place. After M1 they are on every request's path, and the same move becomes a four-phase migration. The costs are near zero: `TransactWriteItems` spans tables, functions link `allResources` so table access needs no per-function IAM work, and the members page becomes one `Query` on `OrgTable` plus a parallel profile `GetItem`.

This sets the standing rule: a new domain gets its own table unless its rows need co-location in an existing partition, and legacy entities move only when already being reworked (billing is getting exactly that treatment in §5). The org profile row stays in `UserInfoTable` for M1 — its reads funnel through `getOrgProfile` (`lib/org-profile.ts:23-30`), so moving it later is a contained step.

The inverse arrangement was considered: evict the unrelated domains instead, leaving org rows beside the identity mapping and profile, and add a GSI for the user-to-orgs lookup. It moves the wrong rows. RAG keys are read on the request path to authenticate bearer callers, trial entitlements gate the login path, and relocating either is a live migration of hot rows, while the move chosen here relocates rows nothing reads yet. Its second half inherits the index's consistency problem (next option), which is the reason the membership lookup is not a GSI in the first place.

### The user-to-orgs access pattern: inverse items vs the first GSI

**Decision: inverse membership items** (`USER#{userId}/MEMBERSHIP#{orgId}`), written in the same transaction as the canonical membership row. Same choice for the invite-token lookup (§4).

"Which orgs does this user belong to" has no access pattern today. A GSI would be the first in the codebase, and **DynamoDB serves every GSI read eventually consistent — there is no `ConsistentRead` on an index.** The index would not touch the authorization read: a caller's role comes from a point `GetItem` on the canonical `ORG#/MEMBER#` row (`lib/org-membership.ts:178`), consistent either way. It would carry the one read that enumerates a user's memberships (`listMemberships`, `lib/org-membership.ts:340`), and two of that read's callers make a one-way decision on the answer: the trial claim (§5) mints a trial only for a user whose sole membership is their personal org, and the deletion teardown (§2) performs the identity teardown on the same census. A membership accepted seconds earlier that the index has not yet reflected reads as absent, and the decision made on that read is a phantom trial or a deleted login. `MeResponse.memberships` would tolerate the lag, since the active org is synthesized into the list (§3); the two census reads cannot. Backfill is no matter at all, since `OrgTable` is new; consistency is the property that does not improve as the table grows. The codebase's own answer is the inverse item (`RAGKEYHASH#…/LOOKUP`, documented at `lib/rag-api-keys.ts:16-18`), which rides the same `TransactWriteItems` as the row it mirrors and reads consistently. What the index would have saved, one item per membership transaction and a denormalized `role`, is paid for by writing both in one transaction, which the membership module already does for the Owner counter.

### Invitation email: direct SendGrid vs Auth0 Organizations invitations vs SES

**Decision: send invitations directly through SendGrid** from a request-path Lambda.

Auth0's invitation API requires adopting Auth0 Organizations (rejected above). SES means a new sending identity, sandbox escape, and reputation from zero; the SendGrid ADR already rejected that trade once. The Mail-Send-scoped `SendGridApiKey` secret gets linked to the invite handler on staging and production; on dev and ephemeral stages, where the secret does not exist, a stage-selected no-op mailer logs the accept URL instead, which is also what the e2e suite drives. Domain authentication for `filone.ai` already lives in the infrastructure repo. Bounce handling stays out of scope for M1; an invite that bounces is retried by re-inviting.

## Open questions

1. **Billing capabilities in the four-role matrix.** With the Billing role cut, this ADR assigns manage-billing to Owner alone and usage/invoice visibility to Owner and Admin. The PRD revision should confirm that split — it decides which routes Admins can call, and it is cheap to change now.
2. **Audit-log visibility.** The review thread narrowed viewing to Admin and above; the PRD's auditor-joins-as-ReadOnly path depends on ReadOnly seeing the audit log. The registry constant is trivially changeable; the product answer decides the M2 viewer's audience and belongs in the PRD revision.
3. **Invited users and personal trials.** This ADR keeps personal-org auto-creation and moves the trial claim to first personal-org use (§4, §5). If product would rather invited users never hold a personal trial claim at all, the mechanism point is the same guard branch — but the current design deliberately preserves the invitee's future entitlement.
4. **Member visibility of the member list.** The matrix lets every role read the members page (names and roles). The PRD is silent; hiding it from Member/ReadOnly is a one-line registry change.
5. **PRD document refresh.** The Google Doc predates the four-role decision, Owner-only privileged grants, and the audit-visibility change, and the tickets cite a v0.4 that is not in the shared doc.
6. **The Auth0 tenant's plan.** Recorded nowhere in the repo. Organizations and inbound SCIM exist on every current tier, but enterprise connections are absent from B2C tiers and metered on B2B (three included, then per-connection pricing) — a real per-customer line item for FIL-945 that should be known before the first SSO conversation, and the same plan move makes Organizations unlimited.
7. **Do enterprise employees get personal orgs at all?** §5 suppresses the phantom trial; suppressing the personal org itself for IdP-provisioned users is a larger and possibly better answer that belongs in the PRD revision alongside item 3.
8. **Org-wide MFA enforcement.** Auth0 cannot know a login's active FilOne org, so a per-org requirement would live in the auth middleware: an `mfaRequired` flag on the org profile, and a session carrying no MFA factor is sent to enrollment before the request proceeds. Auth0 still performs the challenge, and an SSO customer inherits the IdP's MFA through the same `amr`/`auth_time` reading as step-up. Whether M2 takes it is a PRD-revision question.

## Out of Scope

All M2: bucket-scoped access for Member/ReadOnly (FIL-1017); the key-management surface — rotation, expiry, revocation UX, last-used (FIL-1018); privileged-operation grants and their console flows (FIL-1019); the legacy-key relabeling transition (FIL-1020); the full member-removal flow with key review (FIL-1021 — minimal removal ships in M1, §6); the audit viewer and export (FIL-1022); adoption metrics (FIL-1023); per-region capability disclosure (FIL-1024).

All M3: data-plane enforcement, prefix scoping, and revocation propagation bounds (FIL-1025 through FIL-1028).

Out per the PRD: SSO, SCIM, service accounts, groups, custom roles, and per-seat pricing.

## References

- PRD: [Fil One Identity and Access Management PRD](https://docs.google.com/document/d/19zoGbN6EAHkxFbRKa2MlajcPS_GnpuL4lAnBU9kZX3Y/) (Google Doc; August 5 draft plus the #filone-general review thread of the same week)
- Linear: [Identity & Access Management](https://linear.app/filecoin-foundation/project/identity-and-access-management-3cb7f318e367) — M1 issues FIL-1013…FIL-1016, FIL-920
- Backend-enforceability analysis: `iam-prd-enforceability-by-backend.md` in the knowledge-base repo (2026-08-11) — the tier split behind the M2/M3 boundary
- orgauthaudit (`fil-one/orgauthaudit`): an exploratory full-scale RBAC implementation this design harvests patterns from (FIL-1016) — permission registry `packages/shared/src/permissions/`, fail-closed middleware `packages/backend/src/middleware/authorization.ts`, audit envelope `packages/shared/src/audit-events.ts` and writer `packages/backend/src/data/repositories/audit-writer.ts`, delegation boundary `packages/backend/src/authorization/delegation.ts` (M2 reference)
- ADRs this builds on: `2026-03-mfa-enrollment.md`, `2026-05-passkey-primary-authentication.md`, `2026-03-sendgrid-auth0-email-provider.md`, `2026-04-presigned-url-s3-operations.md`, `2026-05-synchronous-tenant-setup-on-first-resource.md`, `2026-04-auto-deploy-to-production.md`
- Current-state docs corrected by this work: `docs/AuthOverview.md`, `docs/Authentication.md`
