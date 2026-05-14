# Test plan: synchronous Aurora tenant setup (FIL-323)

**Date:** 2026-05-13
**Scope:** verification checklist for the inline tenant-setup rework.

Run the automated suite with:

```bash
pnpm --filter @filone/backend test
pnpm typecheck
```

Then walk through the scenarios below in a personal dev stage
(`pnpx sst dev`) and confirm the listed observable behaviour.

## Scenarios

### 1. Fresh org, first bucket creation, fast Aurora setup

1. Sign in as a new user (Auth0 sign-up flow).
2. Call `POST /api/buckets` with a valid body.

**Expect:**

- Response: `201 Created`, bucket details returned.
- DynamoDB org profile transitions
  `FILONE_ORG_CREATED → AURORA_TENANT_CREATED → AURORA_TENANT_SETUP_COMPLETE →
AURORA_TENANT_API_KEY_CREATED → AURORA_S3_ACCESS_KEY_CREATED` within the
  single handler invocation.
- One `AuroraTenantSetupDuration` EMF line is emitted in CloudWatch with a
  sub-second `Milliseconds` value and no dimensions.
- `setupFailureCount` on the org profile is unset / 0.

**✅ CHECK PASSED ✅**

### 2. Fresh org, first access key creation

Same as (1) but via `POST /api/access-keys`.

**✅ CHECK PASSED ✅**

### 3. Tenant setup poll-budget exhaustion

1. Force `setupAuroraTenant` to keep returning `lastSetupStep:
WARM_TIER_ADDED` (or stub Aurora to fail).
2. As a fresh user, call `POST /api/buckets`.

**Expect:**

- Response: `503` with body
  `"We're still setting up your account. Please try again in a moment."`
- One `AuroraTenantSetupDuration` EMF line emitted near the poll-budget
  value (~7800 ms).
- `setupFailureCount` on the org profile is `1`.
- Org profile remains at `AURORA_TENANT_CREATED`.
- A `console.error` line containing `[tenant-setup]`, `orgId`, and the error
  message appears in CloudWatch.

**✅ CHECK PASSED ✅**

### 4. Retry-after-timeout succeeds

Continuing from (3):

1. Restore Aurora to a healthy state.
2. Call `POST /api/buckets` again.

**Expect:**

- Response: `201 Created`.
- **No** new `AuroraTenantSetupDuration` emission — only the original
  `createTenant`-winning invocation emits.
- Org profile reaches `AURORA_S3_ACCESS_KEY_CREATED`.
- `setupFailureCount` retains the value it accumulated during the failed
  attempts (e.g. `1`). It is not reset on success — the counter is a
  monotonic record of failed attempts before setup completed. The
  stuck-tenant alert excludes terminal-status rows, so the elevated count
  on a completed org does not contribute to the gauge.

**✅ CHECK PASSED ✅**

### 5. Stuck-tenant gauge transition up

1. Manually set `setupFailureCount = 2` on an org profile via
   `aws dynamodb update-item`.
2. Trigger another failure (e.g. by keeping Aurora stubbed broken and calling
   `POST /api/buckets` as that org).

**Expect:**

- Counter increments to `3`.
- One `StuckAuroraTenantSetupCount` EMF emission with the current count
  (>= 1, depending on other stuck orgs).

**✅ CHECK PASSED ✅**

### 6. Stuck-tenant gauge transition down

Continuing from (5):

1. Restore Aurora.
2. Retry `POST /api/buckets` for the stuck org.

**Expect:**

- Setup completes (`AURORA_S3_ACCESS_KEY_CREATED`).
- `setupFailureCount` stays at its prior value (≥ 3). The alert filter
  excludes the row because `setupStatus` is terminal.
- One `StuckAuroraTenantSetupCount` EMF emission with the new count
  (smaller by 1) — the terminal advance reads the prior counter via
  `ALL_OLD` and triggers a re-emit because that prior value was ≥ 3.

**✅ CHECK PASSED ✅**

### 7. Concurrent first-bucket requests

1. As a fresh org, fire two parallel `POST /api/buckets` requests.

**Expect:**

- Both eventually return `201` (or one returns `201` and the other `409` if
  they collide on the same bucket name).
- No orphaned Aurora resources (manually inspect tenant / token / S3 key).
- Exactly one `AuroraTenantSetupDuration` EMF emission (only the
  `createTenant` winner emits).

**🟠 UNEXPECTED OUTCOME 🟠**

- Single AuroraTenantSetupDuration EMF: ✅ Pass
- No orphan Aurora resources: ✅ Pass
- Both clients return 201: ❌ Got 503 + 201

Aurora's backoffice doesn't handle concurrent `POST /v1/partners/{partnerId}/tenants` for the same orgId idempotently — it returns 500 instead of 409. This means:

- The current synchronous design correctly serializes the successful path, but the loser of a tight race gets a 503 from us, even though we did nothing wrong.
- A user double-clicking "Create bucket" on a fresh org will see "We're still setting up your account. Please try again in a moment." on one of the two clicks. A second click usually succeeds (org is now
  at AURORA_S3_ACCESS_KEY_CREATED).
- setupFailureCount will tick up on every double-click — a benign but noisy signal.

This is acceptable UX: "user clicked twice, they get one 503 they can retry".

### 8. Concurrent failure increments

1. With `setupFailureCount = 2` already on the org, fire two parallel failing
   `POST /api/buckets` requests.

**Expect:**

- DynamoDB atomic `ADD` serializes them; one observes `newCount === 3`, the
  other `newCount === 4`.
- Exactly one `StuckAuroraTenantSetupCount` EMF emission.

**✅ CHECK PASSED ✅**

### 9. `/api/me` no longer triggers setup

1. As a fresh user (org just created), call `GET /api/me` repeatedly.

**Expect:**

- Org profile stays at `FILONE_ORG_CREATED`.
- No SQS messages sent.
- Response does **not** include `orgSetupComplete` (the field is removed from
  `MeResponse`).

**✅ CHECK PASSED ✅**

### 10. In-flight SQS messages still drain

1. Pre-deploy: enqueue an SQS message via
   `triggerTenantSetup({ orgId, orgName })` (test stage) and verify the org
   reaches a partial setup state.
2. Deploy the new code (which no longer enqueues, but keeps the consumer).
3. Inspect the SQS queue.

**Expect:**

- The pre-existing message is processed by the consumer Lambda and the org
  reaches `AURORA_S3_ACCESS_KEY_CREATED`.
- Queue depth returns to 0; no DLQ growth.

**✅ CHECK PASSED ✅**
