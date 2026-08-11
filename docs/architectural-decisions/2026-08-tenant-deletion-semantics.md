# ADR: Tenant deletion semantics across service orchestrators

**Status:** Accepted
**Created:** 2026-08-06

## Context

Account deletion (FIL-112) tears down every orchestrator tenant an org owns: the upstream tenant
itself plus the FilOne-held secrets in SSM. The teardown is re-runnable, so `deleteTenant` must be
idempotent — but "idempotent" was ambiguous about which upstream responses may be swallowed.

The upstream behaviour was probed against the live FTH management API using throwaway bare tenants
(no storage users, no access keys), exercising the delete sequence and cleaning up afterwards. This
ADR records what that probe established so the orchestrators do not have to restate it inline.

**Evidence levels.** Statements about FTH are **probed** — they come from that script. Aurora
statements are either **probed** (see the evidence section below, run read-only against the dev
backoffice on 2026-08-10), **declared** (read off
`packages/aurora-backoffice-client/aurora-backoffice.swagger.json`, which is authoritative for
response codes and enum semantics but not for runtime behaviour) or **inferred** (a reasoned guess
from the declarations). Each Aurora claim is tagged. An inferred claim is a design assumption, not
a fact, and the code is written so that being wrong about one fails closed. No Aurora _teardown_
has been run end-to-end against a live tenant.

### Aurora evidence (probed 2026-08-10, dev, read-only)

The Aurora rules below were originally derived from the swagger alone. A read-only probe of the dev
backoffice invalidated the central ones. What it established:

| Probe                                        | Result                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ListTenants` with `pageSize=1000`           | **200, but 20 items** — the page size is clamped to 20. `totalCount` was **239**      |
| `GetPartner /v1/partners/{partnerId}`        | **403 `Missing permission read:partners`** for our backoffice token                   |
| `GetPartner` with a bogus partner id         | **404 `Partner not found`** — the id check precedes the permission check              |
| `GetTenant` with a malformed tenant id       | **400**, _not_ the declared 404                                                       |
| Full paginated walk of the partner's tenants | 11 pages, 220 items scanned, our tenant found; `totalCount` 239 — the listing is live |

Three consequences, all load-bearing:

1. **A tenant walk that terminates on a short page is unsafe.** With the clamp, page 1 of a
   239-tenant partner returns 20 items; a loop that stops when `items.length < requestedPageSize`
   concludes "absent" after seeing 8% of the partner. `totalCount` is returned and is the only
   sound bound on such a walk.
2. **We cannot prove the partner scope resolves.** `GetPartner` 403s for our token, so any check
   built on it fails permanently rather than only on evidence. The bogus-id 404 does not rescue
   this: it is returned before the permission check, so it cannot be read as "the partner exists".
3. **`GetTenant`'s not-found response code is not what the swagger declares.** A malformed id
   produced 400, so we do not even know what a well-formed-but-nonexistent tenant id returns.

The listing itself does reflect live tenants, so absence is meaningful **in principle** — but only
via a correct walk that our token is not currently authorized to perform.

## Decision

### DELETE is idempotent via 204 — 404 must fail, never be tolerated

Repeat DELETE of a **resolvable** client ref returns **204, not 404**. A deleted client's ref keeps
resolving on every verb (GET, PATCH, DELETE), so a teardown re-run simply repeats
`PATCH 204 → DELETE 204` and converges. Deletion is therefore idempotent **without any 404
tolerance**.

The only way the probe ever produced a 404 was a ref that never resolved at all — a misrouted
`baseUrl`, a wrong-scope token, or a gateway answering for the wrong service. Those faults make
_every_ ref unresolvable, so reading 404 as "already deleted" would fall through and destroy the SSM
credentials of a client that is still live upstream, leaving an orphaned tenant nobody can reach.

**Implementations MUST fail on 404**, at both the pre-deletion PATCH and the DELETE. Idempotency
comes from the upstream's own repeat-delete success, never from tolerating a not-found.

### 409 means a competing writer, not an unlanded disable

DELETE returns **409 for both `active` and `write-locked`**; only `disabled` passes. The client must
be PATCHed to `disabled` first.

A 409 is **not** a disable that has not propagated yet: the PATCH and the DELETE are both
synchronous, and 15 zero-delay probe trials (PATCH immediately followed by DELETE, the tightest race
a caller can produce) never produced one. A 409 means a **competing writer re-activated the client**
between our two calls — today the trial-lock enforcer in `usage-reporting-worker`, whose scan is not
fenced by the deletion guard.

Each retry attempt therefore re-disables before deleting. The retry budget exists to **outlast
competing writers**, not to wait out propagation delay. It also covers the 5xx an orchestrator may
return when cleanup fails partway through, which the Management API contract says leaves the tenant
deletable on retry.

### Aurora is the exception: disable + verify only

Aurora's Backoffice and Portal APIs expose **no tenant DELETE and no bucket DELETE**. Verified
against `packages/aurora-backoffice-client/aurora-backoffice.swagger.json` and
`packages/aurora-portal-client/aurora-portal.swagger.json`: the only DELETE operations are on
partner/tenant tokens, themes, and individual access keys.

So `auroraOrchestrator.deleteTenant` does exactly two things: force the tenant to `disabled`, then
verify it stayed that way. **Customer data survives**, and so do FilOne's SSM secrets.

#### Why the FilOne-held secrets are retained

An earlier version of this teardown also revoked the tenant's `filone-console` S3 key and deleted
FilOne's two SSM secrets (the portal API key and the console S3 credentials). Both were dropped,
for a reason stronger than brevity: **those secrets are FilOne's only route back to the tenant.**
Deleting a customer's Aurora data later requires reaching the Portal, which requires the portal API
key. Shredding it forecloses the deferred purge (FIL-919) permanently.

Retaining them is safe because a `disabled` tenant "denies all actions" — every credential it owns,
console-issued or user-issued, is already inert. The credential destruction was buying nothing that
the disable does not already provide, while costing the only path to finishing the job.

Deleting the secrets also carried a wrongful-shred risk class of its own: the shred had to be
refused whenever the tenant could not be resolved, since a backoffice client pointed at the wrong
partner would otherwise destroy a live tenant's credentials on a 404. That entire branch — and the
local-SSM-evidence rules it needed to decide "already complete" from "never started" — is gone with
the code.

#### A 404 is nothing left to disable

Aurora's teardown starts from a `GET tenant` probe. A probe that cannot resolve the tenant now
returns successfully: there is nothing to disable, and nothing this teardown holds that would need
cleaning up. This is materially safer than the previous posture, where the same 404 had to be
interrogated against local SSM state before any destructive step could be allowed.


#### The teardown verifies the tenant is still `disabled` before returning

`region-helpers.ts` refuses only `disabled → write-locked`; `disabled → active` is applied, and the
trial-lock enforcer in `usage-reporting-worker` is not fenced by the deletion guard. It can therefore
re-activate a tenant we have just torn down, leaving its data intact and its user-issued access keys
valid. FTH converges anyway because its terminal DELETE ends the race; Aurora, which only disables,
does not.

So Aurora re-probes at the end of `deleteTenant` and throws unless the tenant is `DISABLED`.
Aurora's teardown is wrapped in the same bounded `TENANT_DELETE_RETRY` budget as FTH's, so the
re-attempt re-probes and re-disables in-process.

The comparison is against Aurora's **raw** `models.TenantStatus`, not the orchestrator-agnostic
mapping, which collapses `LOCKED` to `undefined` — indistinguishable from a missing status field.
The failure message is branched on what was actually observed, because most of these are not a
competing writer:

| Observed                  | What it means                                                                                | Exitable by retry?          |
| ------------------------- | -------------------------------------------------------------------------------------------- | --------------------------- |
| `ACTIVE` / `WRITE_LOCKED` | A competing writer re-activated it                                                           | Yes — the retry re-disables |
| probe `error`             | Status unknown; usually transient                                                            | Yes                         |
| probe `not_found`         | The client stopped resolving mid-teardown; the tenant resolved seconds earlier               | Yes, if the fault clears    |
| `LOCKED`                  | Read-only, **not** "denies all actions" (declared in the enum) — the tenant is not torn down | Retried, but not by waiting |
| status absent             | Aurora returned no status field                                                              | **No.** Needs an operator   |

`LOCKED` is not unexitable in itself: the next attempt PATCHes any status other than `DISABLED`, so
the retry does re-issue the disable. What it means when `LOCKED` **survives the retry budget** is
that Aurora is refusing the transition or something is re-locking the tenant — then it needs an
operator. An absent status field genuinely is unexitable: no retry can make an unverifiable
teardown verifiable.

That distinction matters because of the Consequences below: a state no retry can exit is permanent
retention of the org's personal data, so it must be labelled as needing a human — and a state a
retry _can_ exit must not be.

### Deferred Aurora data deletion

Tracked as **FIL-919**. The intended direction is an upstream **tenant-deletion API**: a tenant
delete takes its objects with it, so no data-plane dance is needed.

An earlier revision of this ADR designed one — `write-locked → purge objects via the S3 data plane →
disabled`, since `WRITE_LOCKED` still permits deletes while `DISABLED` denies all actions. That
section has been retired deliberately rather than annotated, so nobody implements it. It also
carried a blocker of its own: `region-helpers.ts` refuses to downgrade a `disabled` tenant back to
`write-locked`, so a retry arrives already disabled with no way to reopen the window.

Whichever mechanism ships, it depends on the FilOne-held SSM secrets this teardown now retains.

## Consequences

- `deleteTenant` implementations wrap their whole teardown in a bounded retry and let every error —
  404 included — surface. **No orchestrator swallows a not-found as licence to delete:** the
  DELETE-based path (FTH) tolerates no 404 at all. Aurora destroys nothing, so its 404 branch has
  nothing to be careless with: an unresolvable tenant has nothing left to disable.
- A backoffice client pointed at the wrong partner can no longer shred live credentials, because
  the teardown no longer shreds anything. The operator wedge that safety used to cost — an org's
  purge blocked until a human deleted two named SSM parameters — is gone with it.
- Aurora orgs leave a disabled tenant and its data behind until FIL-919 ships, and the teardown
  fails (for retry) rather than returning while the tenant is anything but `DISABLED` — with one
  exception. A tenant the backoffice cannot resolve returns success without the verification
  running, because a teardown that destroys nothing has nothing left to do with an absent tenant.
  That path is fail-OPEN and logs a warning, precisely because the misrouted-client scenario above
  404s a live tenant identically: if that is what happened, the account's purge proceeds while the
  tenant is still `ACTIVE`. It is the only `deleteTenant` path that reports success having verified
  nothing.
- **A `deleteTenant` failure blocks the account's DynamoDB purge.** This is the consequence that
  makes everything above load-bearing, and it is deliberate. `runAccountDeletion` tears down every
  region and rethrows an aggregate of the failures **before** `purgeRecords`, so a teardown that
  cannot confirm the tenant is `DISABLED` leaves in place the `ORG#` rows (access keys, RAG keys),
  the `RAGKEYHASH#` lookup rows, the `USER#` profiles, the PII attributes on the `SUB#` identity
  rows, the `CUSTOMER#` billing rows and the deletion challenge, and skips both the second
  (index-lag) Stripe discovery pass and `markDone`.

  It does **not** block everything, and the earlier version of this bullet overstated it in two of
  three parts. `applyDeletionGuards` writes the `SUB#` `deleted` tombstone at the TOP of the run
  (as does the confirm handler before its 200), so every session dies regardless; and the Stripe
  cancel, tombstone and redaction job run in the same `Promise.allSettled` batch as the region
  teardown, so the first-pass redaction is created and persisted even when Aurora throws.

  The trade was still made knowingly: marking an account deleted while a live, reachable tenant
  survives is worse than delaying the record purge. Its price is that **any teardown state no retry
  can exit retains those records**, which is why the non-exitable rows in the table above are
  labelled as needing an operator, and why the 404 branch gives the operator a remediation that
  actually ends the wedge.

## References

- Interface contract: `ServiceOrchestrator.deleteTenant` in
  `packages/backend/src/lib/service-orchestrator.ts`
- [Service Orchestrator Management API ADR](2026-04-service-orchestrator-management-api.md)
