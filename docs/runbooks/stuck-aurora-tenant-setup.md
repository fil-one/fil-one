# Runbook: `StuckAuroraTenantSetupCount > 0`

**Audience:** FilOne oncall / operators.
**Source files:** mirror this into Notion under the FilOne ops runbook collection.

## What the alert means

One or more FilOne orgs have failed Aurora tenant setup at least three times
without ever completing. Each failure increments a per-org
`setupFailureCount`; the gauge counts orgs where that counter is `≥ 3` and
the org is not yet at `AURORA_S3_ACCESS_KEY_CREATED`.

Background: tenant setup is now driven inline by the user's first call to
`POST /api/buckets` or `POST /api/access-keys`. A failure surfaces as a
**503** to the user; they're expected to retry. After three failures the
user is unlikely to recover on their own and the alert wakes us up.

See [ADR 2026-05-13-synchronous-tenant-setup-on-first-resource.md](../architectural-decisions/2026-05-13-synchronous-tenant-setup-on-first-resource.md).

## Find the affected orgs

The error context is **only in logs**, not DynamoDB.

1. In Grafana Loki, search for tenant-setup error lines:
   ```logql
   {service="filone-production"} |= "[tenant-setup]" |= "setup failed"
   ```
   Each matching line includes a JSON-parsable payload with `orgId`, an
   `error` string, and `stack`. Note the `orgId`s.
2. For each suspect `orgId`, narrow to that org's history:
   ```logql
   {service="filone-production"} |= "<orgId>"
   ```
   Look for the underlying Aurora error (typically logged by
   `aurora-backoffice.ts` or `aurora-portal.ts`).

If multiple orgs are stuck on the same Aurora error, treat it as a
platform-wide Aurora incident rather than per-org.

## Common failure modes

### 1. Aurora 5xx / timeouts

**Signal:** `Failed to setup Aurora tenant: ...` with HTTP 5xx, network
errors, or Lambda timeout traces.

**Action:** Check Aurora status (their status page or backoffice ping). If
Aurora is broken, wait for them. The stuck-tenant gauge refreshes the
moment the next user retry succeeds — the terminal-status advance reads
the prior `setupFailureCount` and re-emits the gauge when it was previously
`≥ 3`, so the alert clears immediately. No intervention required.

### 2. Lost SSM secret (orphan in Aurora)

**Signal:** `An Aurora tenant API token with this name already exists`
(`DuplicateTokenNameError`) or `An access key with this name already exists`
(`DuplicateKeyNameError`), and SSM-poll fallback returned "secret lost."

This happens when a prior Lambda crashed between Aurora's `201 Created` and
the SSM `PutParameter` write. Aurora rejects the second creation attempt
(`409`), so every retry surfaces the same error.

**Action — manual recovery:**

1. Identify the `auroraTenantId` from the org profile in DynamoDB:
   ```bash
   aws dynamodb get-item \
     --table-name filone-<stage>-UserInfoTable-... \
     --key '{"pk":{"S":"ORG#<orgId>"},"sk":{"S":"PROFILE"}}' \
     --projection-expression "auroraTenantId, setupStatus, setupFailureCount"
   ```
2. Decide which credential is lost:
   - If `setupStatus` is `AURORA_TENANT_SETUP_COMPLETE`, the **tenant API
     token** is the orphan. SSM path:
     `/filone/<stage>/aurora-portal/tenant-api-key/<tenantId>`.
   - If `setupStatus` is `AURORA_TENANT_API_KEY_CREATED`, the **S3 access
     key** is the orphan. SSM path:
     `/filone/<stage>/aurora-s3/access-key/<tenantId>`.
3. Confirm the SSM parameter is genuinely missing:
   ```bash
   aws ssm get-parameter --name <ssm path above>
   ```
   Expect `ParameterNotFound`. If it's present, recovery is already in flight
   — wait one minute and check the gauge.
4. Delete the orphan in Aurora via the Aurora Backoffice or Portal admin UI
   (use the `filone-<orgId>` token name or `filone-console` access-key name
   under the tenant). Once deleted, the next retry's `createAuroraTenantApiKey`
   / `createAuroraAccessKey` call will succeed.

### 3. Stale `auroraTenantId` (extremely rare)

**Signal:** Aurora returns 404 for an operation against a `tenantId` that
DynamoDB has stored.

**Action:** Investigate manually — likely a data corruption issue, not a
retry-friendly state. Escalate to engineering.

## Recovery procedure end-to-end

After fixing the underlying cause, the alert clears via one of two paths:

- **User retries.** Best path: the user's next `POST /api/buckets` or
  `POST /api/access-keys` succeeds. The terminal-status advance reads
  the prior `setupFailureCount` (≥ 3) via `ReturnValues: 'ALL_OLD'` and
  re-emits `StuckAuroraTenantSetupCount`, dropping the gauge by 1. The
  counter itself is left in place — it stays on the row as a historical
  record of attempts-to-success, and the gauge filter
  (`setupStatus <> :complete`) excludes the row from then on.
- **Operator triggers a retry.** If the user has gone away, we currently
  have no UI for this. See Linear ticket "Build an operator-facing endpoint
  to restart Aurora tenant setup for a stuck org" for the planned tool. As
  an interim measure, email the user asking them to retry. **Note:**
  manually clearing `setupFailureCount` in DynamoDB does not re-emit the
  gauge — only a real `recordSetupFailure` call or a successful terminal
  advance does. Clearing the counter without driving a state transition
  leaves the gauge stale until the next transition event.

## Verification

After resolving:

1. Confirm `StuckAuroraTenantSetupCount` drops to 0 in Grafana within ~1
   minute of the resolution event (whether user retry or operator action).
2. The alert auto-clears once the gauge has been zero for the configured
   evaluation window.
3. Spot-check the resolved org's profile:
   `setupStatus == AURORA_S3_ACCESS_KEY_CREATED`. `setupFailureCount` will
   carry whatever value it accumulated during the failed attempts (i.e.
   `≥ 3` for a previously-stuck org); that is expected — it is now a
   historical record, not active state.
