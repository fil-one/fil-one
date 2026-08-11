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

### Aurora is the exception: disable only

Aurora's Backoffice and Portal APIs expose **no tenant DELETE**. Verified
against `packages/aurora-backoffice-client/aurora-backoffice.swagger.json` and
`packages/aurora-portal-client/aurora-portal.swagger.json`: the only DELETE operations are on
partner/tenant tokens, themes, and individual access keys.

So `auroraOrchestrator.deleteTenant` does one thing: force the tenant to `disabled`, which "denies
all actions" and renders every credential it owns inert. **Customer data survives**, and so do
FilOne's SSM secrets.

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

#### No post-teardown verification

`deleteTenant` forces the tenant to `disabled` and returns. It does not re-probe, and it does not
fail closed on a non-`DISABLED` status — an earlier revision did both, and that machinery is gone in
favour of the same shape FTH uses.

**The residual, stated plainly:** `region-helpers.ts` refuses only `disabled → write-locked`;
`disabled → active` is applied. So a competing writer can re-activate a tenant we just disabled, and
nothing detects it — the account can be marked deleted with its tenant `ACTIVE` and its user-issued
access keys valid.

What keeps that acceptable rather than reckless is that the org-profile `deleting` guard already
refuses `desired: 'active'` for a deleting org, so the only surviving window is a writer that read
the profile *before* the guard landed. That is narrow, and it is the same exposure FTH lives with.


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
- Aurora orgs leave a disabled tenant and its data behind until FIL-919 ships. The teardown does not
  verify the disable stuck, so a writer that re-activates the tenant afterwards goes undetected; see
  the residual under "No post-teardown verification".
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
