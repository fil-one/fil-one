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

- `deleteTenant` implementations wrap the disable+delete pair in a bounded retry and let every error
  — 404 included — surface. No orchestrator swallows a not-found.
- Re-running the account-deletion teardown is safe: the upstream answers 204 again.
- A misconfigured orchestrator client fails loudly instead of silently shredding live credentials.
- Aurora orgs leave a disabled tenant and its data behind until the purge above is built.

## References

- Probe script: `bin/probe-fth-tenant-delete.ts` (untracked; run with `--confirm`)
- Interface contract: `ServiceOrchestrator.deleteTenant` in
  `packages/backend/src/lib/service-orchestrator.ts`
- [Service Orchestrator Management API ADR](2026-04-service-orchestrator-management-api.md)
