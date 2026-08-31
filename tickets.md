# IAM M1 follow-ups

Everything the M1 stack deferred with a decision — #597–#610 plus the close-out
#617, under stack #611, above ADR #596. Each item is real, bounded, and was left
out on purpose; the body says what is wrong and why it waited. Items the reviews
rebutted, and items later commits fixed, are not here.

File references point at the top of the stack.

## Security and step-up

### Gate the Owner-granting routes behind step-up

`requireMfaIfEnrolled()` covers `POST /api/org/transfer` alone, because transfer
is the one verb that takes the caller's own authority away. Owner can still be
granted with no step-up through `POST /api/org/invitations {role: "Owner"}` or
`PATCH /api/org/members/{userId}`, and Owner removal is un-gated too. The
strongest form: a hijacked Owner session invites a second Owner, then calls
`DELETE /api/org/members/{originalOwner}`, which passes the `ownerCount > :one`
condition — persistence that outlives the stolen session and locks the
legitimate Owner out. Extend the middleware to the Owner-granting branches of
`create-invitation` and `update-member-role`, plus Owner removal. Scoped to
FIL-945.

### Throttle invitation sends per org before the beta widens

`packages/backend/src/handlers/create-invitation.ts` — the 25-invite cap bounds
how many invitations can be outstanding, not how much mail goes out: revoking
frees a slot immediately, so a loop of invite-revoke-invite sends without limit
from a sender identity shared with Auth0's own mail. Today every account that
can reach the route is a named, hand-admitted beta org, which is what makes this
wait. It should land before `ORGS_BETA` widens.

### Check the creator's permission on the RAG bearer path

`packages/backend/src/middleware/rag-query-auth.ts:146` — the bearer branch
calls `requireMembership()`, which accepts any row that exists.
`resolveMembership()` deliberately returns a row with zero permissions when the
role is unrecognized, and the cookie path then denies it through
`requirePermission()`. The bearer path does not, so a key whose creator holds a
corrupt or partially converted role still reaches the query handler. Check
`buckets.read` here so both paths fail closed on the same data.

### Run the body-dependent permission checks before the subscription guard

`subscriptionGuardMiddleware` short-circuits in its `before` hook, so a
role-denied caller on a canceled subscription gets a billing error instead of
`FORBIDDEN_ROLE`, and pays the billing read on the way. Both answers are
denials, so nothing unpermitted runs; what is wrong is which reason the caller
is given, and that authorization is supposed to come first. Three handlers do
their check in `baseHandler`, behind the guard, because what they check depends
on the body — so each has to move ahead of the guard rather than into the chain:

- `packages/backend/src/handlers/presign.ts:281` — `putObject` against
  `getObject` decides which permission applies.
- `packages/backend/src/handlers/set-bucket-rag-enablement.ts:72` — enabling
  costs `buckets.create`, disabling costs `buckets.delete` (guard installed at
  :136).
- `packages/backend/src/handlers/create-access-key.ts:46` — the requested
  authority decides the ceiling (guard installed at :325).

### Refuse a cross-org user during conversion instead of granting ownership

`bin/convert-orgs-to-orgtable.ts:203` — the projection discards the `orgId` held
on `USER#{userId}/PROFILE`, and classification then asks only whether the user
id is known. A legacy `MEMBER#` row or `PROFILE.createdBy` naming a valid user
from a different org is therefore converted into an Owner membership and inverse
item in the org being converted. No pre-M1 writer produces that data and the
script prints its plan before applying, which is why this waited. Carry each
profile's `orgId` through and require it to match.

## Billing

### Keep newer org state when the re-key revert runs

`bin/lib/billing-rekey.ts:566` — if an application update reaches the org row
but its legacy update then fails, the org row is newer than its fallback and
still carries `rekeyedFrom`, because an ordinary `UpdateItem` does not remove
that attribute. The revert deletes the newer row anyway and returns the account
to stale billing state. Confined to a break-glass revert running after a dual
write already failed halfway, and the next webhook delivery restores the state.
Require the fallback to be at least as current as the org row before deleting.

### Make the backfill's faithfulness check direction-aware

`bin/lib/billing-rekey.ts:196` — `classifyOrgBilling` treats an org row that is
newer than its legacy source as safe (the newer-than branch at :222), because it
is authoritative and survives the flip. The comparison behind `--verify` still
includes `updatedAt` (`COMPARED_ATTRIBUTES`, :102, read by the `compareRows`
call at `bin/lib/billing-verify.ts:204`), so it reports divergence forever on
exactly those rows, and another backfill run skips them rather than repairing
them. `--verify` is the migration gate, so a row it cannot pass and cannot fix
blocks the gate. Compare in one direction.

### Serialize Stripe customer creation per org

`packages/backend/src/handlers/create-setup-intent.ts` swallows the
`ConditionalCheckFailedException` when its `attribute_not_exists(pk)` write
loses, then issues the SetupIntent against its own just-minted customer — a
customer the billing row never references. Two concurrent first-billing-touch
requests (a double-click today; two Owners once the beta widens) can therefore
attach a payment method to an orphan. The loser should re-read the row, adopt
the winner's `stripeCustomerId`, and best-effort delete its orphan at Stripe.
The same race predates the re-key under `CUSTOMER#` keys; the org invariant
makes it worth closing now.

## Console and accessibility

### Give a Textarea inside a FormField its error description

`packages/website/src/components/FormField.tsx:38-54` wires the error message
through Headless UI's `Field` and `Description`, and its own doc says the
control inside reads the ids for its `aria-describedby` from that context.
`TextArea.tsx:13-18` renders a plain native `<textarea>`, which consumes no such
context, so the error text is rendered but never associated with the field. Live
call sites: `SupportPage.tsx:136`, `billing/ContactSalesDialog.tsx:145`,
`InterestForm.tsx:218`. (`aria-invalid` itself lands correctly here — the merge
bug that swallowed it was specific to `Input`'s Headless UI wrapper and is
fixed.)

### Announce the sidebar user menu as a popup

`packages/website/src/components/SidebarNav.tsx:386-409` — the trigger carries
no `aria-expanded` and no `aria-haspopup`, so a screen reader announces a button
that does nothing. The panel's contents are already labelled
(`OrgSwitcher.tsx:58-59` renders `role="group"` with `aria-label`), and the
mobile twin at `AppShell.tsx:41-52` already sets both attributes, so the fix is
to match the pattern that exists. Pre-existing on main rather than introduced by
this stack.

### Reconcile the roster after a stale-target refusal

Two shapes of the same staleness: a role change on a member who was promoted
to Owner elsewhere returns `FORBIDDEN_ROLE`, and a transfer whose target was
removed or promoted in another tab returns its permanent 404/409 — in both,
the handlers (`packages/website/src/pages/MembersPage.tsx`) only toast, the
global denial handler refreshes `/me` alone (`lib/query-client.ts:44-47`),
and the stale row keeps offering the same refused actions. Invalidate the
members query on these denials, and close or revalidate the transfer dialog's
target. A removal answered 404 or 409 already does exactly that — invalidates
`queryKeys.members`, drops the row, and says so — which is the shape to copy.

### Supersede expired same-address rows when re-inviting

`create-invitation.ts` revokes-and-replaces only usable same-address rows,
while `list-invitations.ts` deliberately returns expired rows flagged and
revocable. Re-inviting an expired address therefore leaves two rows on the
invitations surface, the fresh one and the expired one, which reads against
the form's replacement behavior. Revoke expired same-address rows in the
create transaction; the audit event already records what happened to them.

### Narrow cached data when a role narrows

Three places keep showing data the caller could see a moment ago. In each, the
server scopes every fresh read, so the exposure is bounded to rows already
delivered to that browser and ends at the next refetch.

- `packages/website/src/pages/ApiKeysPage.tsx:479` — an Admin downgraded to
  Member keeps `mayList` (both roles hold `keys.manage_own`), so the cached
  org-wide response stays on screen with only the per-row actions narrowed.
- `packages/website/src/pages/DashboardPage.tsx:436` — `accessKeys.count` is the
  org's raw key count, authorized by `buckets.read`, so Member and ReadOnly see
  an inventory total they cannot list.
- `packages/website/src/lib/query-client.ts:47` — a denial-triggered refresh
  invalidates `['me']` only, leaving `['activity', 'recent', 5]` rendering
  colleagues' key events.

### Disarm the logout clear handler when logout is cancelled

`packages/website/src/lib/active-org.ts:187` — if an upload's `beforeunload`
prompt cancels logout, the one-shot `pagehide` listener stays armed for four
seconds and cannot tell the abandoned logout from the next navigation. A Back
press or an org switch inside that window clears the active-org stash, possibly
after `switchToOrg` wrote its new value, and the destination loads the personal
org. Remove the listener when the logout attempt is abandoned rather than only
on the timeout.

### Clean up the invitation notices when a revoke finds a stale row

`packages/website/src/pages/MembersInvitations.tsx:189` — when another tab has
already accepted or revoked the invitation, the backend answers
`INVITE_NOT_FOUND`, so this branch knows the row is gone. It requests refetches
but skips `dropInvitation`, `refusals.clear()` and `undelivered.clearFor()`, all
of which the success path runs. If the refetch then fails, the stale row stays
actionable and its undelivered warning and cap refusal stand over an invitation
that is confirmed gone.

### Put the org's member count on /me

`packages/website/src/lib/use-members-surface.ts:45` decides the members surface
from the caller's own membership count and `orgsBeta`, and `MeResponse` carries
nothing about the org's shape. One org shape therefore reads wrong: the founding
Owner of a multi-member org holds a single membership, because every invited
member keeps the personal org signup created for them and only the founder does
not. Revoking that org's beta row takes the roster, the role picker, removal and
transfer off their console while `GET /api/org/members` and the three writes keep
serving — the org has members, and the person responsible for them cannot see
them. `bin/orgs-beta.ts` refuses that revoke without `--force-members`, which is
the operator-side half of the answer. The durable half is the count: carry the
org's member count on `MeResponse` and let the surface read the org's shape
rather than the caller's, which is the deferral
`docs/architectural-decisions/2026-08-organizations-roles-m1.md:135` names.

## Infrastructure and CI

### Give each package a tsc script for editor and CLI parity

Type errors are caught on every PR: `oxlint.config.ts` sets `typeAware` and
`typeCheck`, and `pnpm lint` runs first in `packages-ci.yaml` and again as the
first half of `pnpm test`, so a misspelled required prop fails CI. What is
missing is a way to ask the same question by hand — no package has a `typecheck`
script. `tsc -p <package> --noEmit` exits clean for backend, shared and website,
so the script is all that is left. Add a plain one per package, so an editor, a
pre-push hook and CI all answer alike.

### Narrow the audit table's grant to PutItem and Query

`sst.config.ts:594` links `auditTable` through `allResources`, the list every
route uses, so every API handler holds `dynamodb:*` on the audit table. The
config says as much where the table is defined (`sst.config.ts:152-155`):
"Handlers reach this table with the same allResources link every route uses, so
they hold dynamodb:\* on it. Narrowing the audit grant to PutItem/Query is
follow-up work: it is the one table where a handler holding DeleteItem
contradicts the append-only claim." Link it through a restricted grant instead
of the shared list.

### Retire the hand-maintained backend sst-env.d.ts

`packages/backend/src/sst-env.d.ts` claims to be generated by `sst types`, which
nothing in the repo runs. It is the only declaration of three resources that no
longer exist in `sst.config.ts` (`UploadsTable`, `AuroraTenantSetupQueue`,
`BillingTrialSetupQueue`), and it declares `Auth0ClientId.type` as `sst.Secret`
where the generated root file says `sst.sst.Secret` — two declaration-merged
blocks in one program disagreeing about the same key. It is also the only
declaration of `SendGridApiKey`, which the root file cannot carry because that
secret does not exist on a preview stage. Decide whether the file earns its
keep and fix the header either way.

### Dedupe the org-profile read on requests that already made it

`packages/backend/src/middleware/org-context.ts:102` — `enforceIdentityProvider`
reads `ORG#{orgId}/PROFILE` with `ConsistentRead`, and `auth.ts:555` calls it for
every request carrying a membership row, so every authenticated request now pays
one `GetItem` it did not pay before. The cost was accepted deliberately: the read
is what closes the bypass-by-omission hole, and a failure of it is a 503 rather
than a served request. What is left is that `get-me.ts:33` reads the same row a
second time on the same request, and a dashboard load fires four requests that
each pay it.

### Move the org profile row into OrgTable

`ORG#{orgId}/PROFILE` is the one org-domain row still living in `UserInfoTable`;
the ADR's data-placement decision defers the move. Reads funnel through
`getOrgProfile` (`packages/backend/src/lib/org-profile.ts`); the writers are the
first-login transaction, org rename, tenant setup, and the billing identity
guard. A small standalone PR: new key builder, writer updates, one migration
script under `sst shell` (dry run, verify, delete originals). Raised by bajtos
on #596.

### Assert the converted role, not just agreement between the two rows

`bin/lib/org-verify.ts:165` — the check compares the role on the membership row
against the role on its inverse item and passes when they agree. Two halves
carrying the same wrong value, a partially copied legacy `admin` or no role at
all, therefore produce `VERIFY: PASS`. Enforcement consumes the role literally,
so the migrated user silently loses Owner authority. This command is the rollout
gate, so validate the expected `owner` on both rows.

## Backend correctness

### Give the HubSpot scanner the shared subscription scan

`jobs/hubspot-contact-sync.ts` keeps a private `scanSubscriptions` instead of the one in `subscription-store.ts`, so it alone skips `scannableOwner` filtering and `assertOneRowPerOrg`, and a leftover `CUSTOMER#` row can still overwrite webhook-current HubSpot status until the dated cleanup removes it. Converge on the shared scan.

### get-me leaks an unhandled rejection when the org-profile read fails

`activeOrgProfile` is consumed twice — once by `Promise.all`, once by a `.then()` chain handed to `summarizeMemberships` — and when the read rejects, the second consumer is never awaited. Harmless in Lambda today, but it fails any vitest run that exercises the failure and it is one refactor away from a real unhandled rejection. Award the promise a single owner.

### Page the key queries before filtering by creator

Three reads filter the first Query page and ignore `LastEvaluatedKey`, and none
of the endpoints exposes a cursor. Once an org's key rows exceed 1 MB, the rows
that sort into later pages disappear from the answer permanently — for
`list-access-keys` that means a Member cannot revoke credentials they created.
Far beyond any current tenant's key count, which is why this waited. Walk every
page before applying the scope filter.

- `packages/backend/src/handlers/list-rag-api-keys.ts:43`
- `packages/backend/src/handlers/list-access-keys.ts:62` — one `QueryCommand`,
  `withinScope` applied at :95.
- `packages/backend/src/handlers/get-activity.ts:200` —
  `fetchAccessKeyActivities`, the same shape.

### Align the invitation email bound with the audit payload limit

`packages/backend/src/handlers/create-invitation.ts:122` — `CreateInvitationSchema`
accepts an address up to 320 characters, and putting `email` in the audit details
throws `ProhibitedAuditContentError` above `AUDIT_DETAIL_MAX_STRING_LENGTH` of 256. An address between 257 and 320 characters is accepted by the public schema
and answered with a 500, having created no invitation. Constrain the request to
the audit limit, or permit the documented length in audit details.

### Treat top-level throttling as a retry-safe audit failure

`packages/backend/src/lib/audit.ts:519` — the best-effort mode's allowlist does
not classify a top-level `ProvisionedThroughputExceededException`,
`ThrottlingException`, or `RequestLimitExceeded` as safe to retry, though
DynamoDB has applied nothing in those cases. After an external key revocation
succeeds, audit-table throttling can therefore stop the local key row being
deleted and return an error, which is the opposite of what the mode promises.
The SDK retries throttling first, so reaching this needs exhausted retries.

### Decide what 90-day audit retention bounds, and filter on it at read

`AUDIT_RETENTION_DAYS = 90` (`packages/shared/src/audit.ts:370`) is stamped as a
DynamoDB `ttl` attribute and nothing else (`lib/audit.ts:363`). DynamoDB deletes
expired items asynchronously and keeps returning them from queries until it
does, so the table enforces "about 90 days" rather than the stated maximum.
Nothing reads audit events yet, which is why this waited. The M2 viewer has to
filter on `ttl` at read; the decision it needs first is whether the 90 days
bounds what the table stores or only what the viewer shows, because a retention
claim about stored data needs a sweep behind it, not a TTL.

### Restrict phased audit events to vendor-backed keys

`packages/shared/src/audit.ts:266` — the type grants `intent` and `completion`
phases on the strength of the event being `key.created` or `key.deleted`, even
when `details.keyKind` is `rag`. A pure-DynamoDB RAG mutation could then put its
intent outside the mutation transaction and lose the atomic guarantee the phased
types exist to enforce. Nothing does today: every RAG mutation commits through
`commitAudited` single-phase. Discriminate the phases by key kind.

### Give profiles that predate the email stamp an address

`remove-member.ts` sweeps invitations addressed to the member being removed by
reading `USER#{userId}/PROFILE.email`. Signup now stamps it and the login path
repairs an older profile, so any account that authenticates once is covered. An
account dormant since before the stamp still has no address, and its removal
narrows the sweep to the invitations that member issued — the behaviour that
predates the stamp, logged where it happens.

The conversion script deliberately backfills nothing: the only stored addresses
are on the oldest legacy `MEMBER#` rows, which the project stopped maintaining
on purpose (`bin/convert-orgs-to-orgtable.ts:199-202`, commit 4f02a70, "removing
stored email entirely to resolve issues when email is changed") and never marked
verified. Sweeping by an unproven address revokes somebody else's invitation.
Auth0's Management API is the one trustworthy source, and a rate-limited
per-account round trip inside a migration script is a new mechanism rather than
a backfill.

### Fence invite acceptance for a member whose conversion has not run

`accept-invitation.ts` condition-checks the accepter's own home org as well as
the destination, so the deletion census cannot delete their Auth0 identity while
the membership commits. That the home org is the right one to fence rests on it
being their sole non-invited membership: `repointHomeOrg` only ever moves the
home org to one they still belong to, and the census never tears an account down
from an invited membership. A member whose conversion has not run has neither
`source` nor inverse items, so the census can act on any org where they are the
sole member, and for them the reasoning stops being a proof even though the
fenced org is the same org in practice. It closes when the conversion has run
everywhere. The ADR's account-deletion section still describes acceptance as
fencing the destination org alone and should record the second check.

### Leave an ambiguous vendor deletion dangling rather than recording failure

`packages/backend/src/handlers/delete-access-key.ts:102` — when the provider
accepts the delete but the response is lost or times out, `deleteAccessKey`
throws and this catch records a definitive `failed` completion. The audit trail
then claims the revocation failed at exactly the moment its outcome is unknown,
and the key may well be gone. The mint path deliberately leaves generic vendor
errors dangling for reconciliation; this path should match.

## Product decisions

### Decide whether a Member or ReadOnly can leave an organization

There is no way to leave. `remove-member` costs `members.manage`, which neither
role holds, and the console's `DangerSection` is still a `mailto:` placeholder,
so leaving would be the first real destructive action on that page. The backend
already allows self-removal under the ordinary rules, including the guard that
stops the last Owner leaving, so this is a product call about the affordance
rather than a missing capability. (The related self-demotion trap is closed: a
role change on the caller's own row now goes through the confirm dialog.)

### Name the organization in lifecycle and marketing email

Comms should always say which organization they concern. Preferences and
marketing subscription state are keyed by email address, not by org —
`packages/backend/src/lib/hubspot-client.ts:54` and
`packages/backend/src/handlers/get-preferences.ts:13-23` — so a person in two
orgs receives mail that cannot say which one it is about, and an invitation is
the one message today that names the org. Decide what carries the org through
and where.

### The ADR's open questions

`docs/architectural-decisions/2026-08-organizations-roles-m1.md:194-202` records
seven, each needing a product answer rather than an implementation: billing
capabilities in the role matrix; audit-log visibility, currently Admin and above
against a PRD that has auditors join as ReadOnly; whether an invited user should
hold a personal trial claim at all; whether Member and ReadOnly should see the
member list, which is a one-line registry change; refreshing the PRD; the Auth0
tenant plan for enterprise connections under FIL-945; and whether enterprise
employees get personal organizations at all.
