# ADR: Tenant deletion semantics across service orchestrators

**Status:** Accepted
**Created:** 2026-08-06

## Context

Account deletion (FIL-112) tears down every orchestrator tenant an org owns: the upstream tenant
itself plus the FilOne-held secrets in SSM. The teardown is re-runnable, so `deleteTenant` must be
idempotent — but "idempotent" was ambiguous about which upstream responses may be swallowed.

The upstream behaviour was probed against the live FTH management API with
`bin/probe-fth-tenant-delete.ts`, which creates throwaway bare tenants (no storage users, no access
keys), exercises the delete sequence, and cleans up after itself. This ADR records what that probe
established so the orchestrators do not have to restate it inline.

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

### Aurora is the exception: disable + secret-shred only

Aurora's Backoffice and Portal APIs expose **no tenant DELETE and no bucket DELETE**. Verified
against `packages/aurora-backoffice-client/aurora-backoffice.swagger.json` and
`packages/aurora-portal-client/aurora-portal.swagger.json`: the only DELETE operations are on
partner/tenant tokens, themes, and individual access keys.

So `auroraOrchestrator.deleteTenant` performs the strongest teardown available remotely — force the
tenant to `disabled`, revoke the console S3 key upstream, delete the FilOne-held SSM secrets — and
logs the manual backoffice follow-up. **Customer data survives.**

#### A 404 never deletes an Aurora credential

Aurora's teardown starts from a `GET tenant` probe, and `getTenantStatus` maps **any** 404 to
`not_found`. The systemic faults above (wrong `AURORA_PARTNER_ID`, misrouted
`AURORA_BACKOFFICE_URL`, wrong-scope token) 404 every tenant identically, so a bare `not_found`
cannot distinguish "this tenant is gone" from "we are talking to the wrong place". Losing the two
SSM secrets for a live tenant is unrecoverable: they are the only way FilOne can reach it, and
`processTenantSetup` will not re-mint either once `auroraSetupStatus` is terminal.

Corroborating the 404 upstream was designed and then abandoned: the evidence section above shows
that the two calls it needs cannot be made soundly with the access we have (`GetPartner` 403s;
a `ListTenants` walk that terminates on a short page sees 20 of 239 tenants). So:

**The rule: FilOne never deletes Aurora credentials in response to a 404.** Only a confirmed
teardown of a tenant that actually resolved and was disabled, or an operator's manual SSM deletion,
removes them.

The 404 branch decides from **local** evidence only — whether FilOne still holds the tenant's two
SSM parameters (`/filone/{stage}/aurora-portal/tenant-api-key/{tenantId}` and
`/filone/{stage}/aurora-s3/access-key/{tenantId}`):

- **Both already absent** → nothing is left to do. This is the idempotent-completion exit: a
  previous pass finished this teardown, or an operator did the manual cleanup below. Logged, not
  warned — `purgeRecords` calls `deleteTenant` a second time for late regions, so a repeat pass is
  routine, and warning on it would drown the anomaly signal.
- **Either still present** → **throw, deleting nothing.** The message states that the tenant did
  not resolve, that credentials will not be deleted on an unexplained 404, and that an operator
  must confirm upstream and then delete the named parameter(s) by hand. That manual deletion is the
  signal that lets the next pass take the branch above, so the wedge has an achievable exit that
  needs no Aurora permission FilOne lacks.

Only SSM's `ParameterNotFound` counts as absence; any other read failure (AccessDenied, throttling)
propagates, because "we could not read it" must never be mistaken for "it is gone".

This is strictly stronger than corroboration: it removes the wrongful-shred class entirely rather
than gating it behind checks whose premises we could not verify.

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

A retry after the shred is safe with respect to SSM — both deletes treat `ParameterNotFound` as
success. A later pass that finds the portal API key missing from SSM cannot revoke or verify
anything, and what it should say depends on local evidence, not on an assumption about earlier
runs: if the console S3 credentials are gone too, an earlier pass completed the teardown and
already reported whatever it observed, so this is the routine repeat pass and is logged; if they
survive while the portal key does not, nothing establishes that the console key was ever revoked
and the pass warns.

### Future Aurora purge sequence

The correct purge order is `write-locked → purge objects via the S3 data plane → disabled`, because
Aurora's `models.TenantStatus` enum documents `WRITE_LOCKED` as "blocks writes but still allows reads
and deletes" and `DISABLED` as "denies all actions". Only the `write-locked` window can issue the
object deletes.

That window cannot be reopened: `packages/backend/src/lib/region-helpers.ts:130-133` refuses to
downgrade a `disabled` tenant back to `write-locked` (`disabled` is the stronger lock and may only be
lifted by an explicit re-activation). A teardown retry therefore arrives with the tenant already
`disabled` and no way to purge. Whoever builds the purge must make it idempotent and **record
completion on the DELETION record** so a retry can tell "purged" from "never purged".

## Consequences

- `deleteTenant` implementations wrap their whole teardown in a bounded retry and let every error —
  404 included — surface. **No orchestrator swallows a not-found as licence to delete:** the
  DELETE-based path (FTH) tolerates no 404 at all, and Aurora's disable+shred deletes nothing on
  one. Aurora's 404 branch returns successfully in exactly one case — both SSM secrets are already
  gone, so there is nothing left to delete — which is idempotent completion, not tolerance.
- Re-running the account-deletion teardown is safe: the upstream answers 204 again.
- A backoffice client pointed at the wrong partner fails loudly instead of silently shredding live
  credentials, and does so without depending on any Aurora call succeeding.
- The cost of that safety is a wedge: a genuinely deleted Aurora tenant whose FilOne secrets still
  exist blocks the org's purge until an operator deletes the two named SSM parameters. That is
  deliberate — the remediation is cheap, auditable, and available to us, whereas a wrongful shred
  is unrecoverable.
- Aurora orgs leave a disabled tenant and its data behind until the purge above is built, and the
  teardown fails (for retry) rather than returning while the tenant is anything but `DISABLED`.
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

- FTH probe script: `bin/probe-fth-tenant-delete.ts` (untracked; run with `--confirm`)
- Aurora probe script: `bin/probe-aurora-tenant-delete.ts` (untracked; read-only)
- Interface contract: `ServiceOrchestrator.deleteTenant` in
  `packages/backend/src/lib/service-orchestrator.ts`
- [Service Orchestrator Management API ADR](2026-04-service-orchestrator-management-api.md)
