# Tenant setup: idempotency and concurrency analysis

Date: 2026-05-12
Branch: `fil-323-defer-creation-of-tenant`

## Context

The current architecture triggers Aurora tenant setup asynchronously via a FIFO SQS queue (`AuroraTenantSetupQueue`). We are considering moving `processTenantSetup` out of the SQS handler and invoking it **synchronously** inside the `create-bucket` and `create-access-key` handlers. Dropping SQS removes deduplication and serialization: two concurrent user requests for the same `orgId` (e.g., a double-click on "Create bucket", or back-to-back create-bucket / create-access-key calls) will land both invocations in `processTenantSetup` concurrently.

This document analyzes the idempotency of each step in the chain, the race conditions that exist today, what changes after the move, and the minimum hardening required.

**Working assumption on Aurora setup latency**: typical setup completes in under 1 second; p99 is under 10 seconds.

## How `processTenantSetup` works

`packages/backend/src/lib/aurora-tenant-setup.ts:25-79` is a **state machine** driven by `setupStatus` in `UserInfoTable[pk=ORG#<id>, sk=PROFILE]`. Each invocation reads the current status and resumes from there:

```
undefined / FILONE_ORG_CREATED
   → createTenant → runSetup → createAndStoreApiKey → createAndStoreS3AccessKey
AURORA_TENANT_CREATED
   → runSetup → createAndStoreApiKey → createAndStoreS3AccessKey
AURORA_TENANT_SETUP_COMPLETE
   → createAndStoreApiKey → createAndStoreS3AccessKey
AURORA_TENANT_API_KEY_CREATED
   → createAndStoreS3AccessKey
AURORA_S3_ACCESS_KEY_CREATED
   → no-op
```

Every step that mutates external state is followed by a DynamoDB `UpdateItemCommand` with a `ConditionExpression` checking the previous expected status, so the status only ever advances one notch at a time.

## Step-by-step idempotency analysis

### 1. `createTenant` — `aurora-tenant-setup.ts:81-104`

- **Aurora call**: `createAuroraTenant({ name: orgId, ... })`. On HTTP 409 (`aurora-backoffice.ts:73-82`), falls back to `findAuroraTenantByOrgId`, which lists tenants and matches by `name === orgId`. **Idempotent on Aurora side.** A second concurrent caller gets the same `auroraTenantId`.
- **Dynamo write**: conditional update — expects `attribute_not_exists(setupStatus) OR setupStatus = FILONE_ORG_CREATED`. Two concurrent winners can't both succeed: one will fail with `ConditionalCheckFailedException`.
- **Problem**: `ConditionalCheckFailedException` is **not caught**. It bubbles up to the handler as a 500.

### 2. `runSetup` — `aurora-tenant-setup.ts:106-132`

- **Aurora call**: `setupAuroraTenant({ tenantId })` → `setupTenant` POST. Idempotent on Aurora's side — it returns per-component setup state from which we derive an overall `lastSetupStep`. Calling it repeatedly is safe.
- **Aurora setup is asynchronous but fast in practice — typically <1 s, p99 <10 s.** The single POST may return mid-progress, and the code throws if `lastSetupStep !== 'FINISHED'`. With this latency profile, an inline poll-on-not-finished pattern fits comfortably under API Gateway's ~30 s budget: a short loop (e.g. 1 s, 2 s, 4 s, …) covers the p99 case with margin and reserves time for the remaining steps. A pathological >30 s case still has to fall back to "return 503, client retries," but the everyday path is a single round-trip.
- **Dynamo write**: conditional — expects `AURORA_TENANT_CREATED`. Concurrent winners → one `ConditionalCheckFailedException`, uncaught.

### 3. `createAndStoreApiKey` — `aurora-tenant-setup.ts:134-164`

- **Aurora call**: `createTenantToken({ name: 'filone-<orgId>' })` (`aurora-backoffice.ts:192-229`). **Aurora rejects duplicate names with 409** — confirmed empirically against the dev backoffice via `bin/aurora-token-demo.ts`. The OpenAPI spec also declares this (`CreateTenantTokenErrors[409]`).
- **No 409 handler** in our code: any 409 falls through `aurora-backoffice.ts:206-211` and throws a generic "Aurora API key creation failed" error. So the actual concurrency outcome is:
  - **Winner**: creates token, writes to SSM, advances status → success.
  - **Loser**: gets 409, throws, user sees a 500. **No orphaned token in Aurora** (Aurora's unique constraint prevented the second insert).
- **Real residual hazard — lost secret on crash mid-flight**: if a prior attempt got past `createTenantToken` (201, token returned) but crashed before `PutParameter` wrote it to SSM, the token value is gone (Aurora only returns it on creation). Every subsequent attempt now gets 409 and throws — the chain is stuck, and there is no recovery path. SQS retries today don't escape this state either; it would need DLQ + manual intervention.
- **Dynamo write**: conditional on `AURORA_TENANT_SETUP_COMPLETE`. Concurrent loser raises uncaught.

### 4. `createAndStoreS3AccessKey` — `aurora-tenant-setup.ts:166-247`

- **Aurora call**: `createAuroraAccessKey({ keyName: 'filone-console' })`. This **does** handle 409 (`DuplicateKeyNameError`) explicitly, intended for sequential retries:
  - Read SSM `/filone/<stage>/aurora-s3/access-key/<tenantId>`.
  - If SSM has the credentials → assume prior run succeeded, advance status.
  - If SSM is empty → re-throw, secret is genuinely lost, escalate to DLQ.
- **Concurrency hazard**: This recovery is correct for sequential retries but has a **check-then-act race** under concurrency:
  1. Invocation A calls Aurora, gets credentials.
  2. Invocation B calls Aurora **before A writes SSM**, gets `DuplicateKeyNameError`.
  3. B reads SSM → empty → throws "secret is lost" as a hard error, even though A is moments away from writing it.

  Result: B surfaces a false-positive critical error to the user; A succeeds silently moments later.

- **SSM `PutParameter` with `Overwrite: true`**: only A has credentials (B got 409), so there's no double-write of different values. The SSM step itself is safe.
- **Dynamo write**: conditional on `AURORA_TENANT_API_KEY_CREATED`. Concurrent loser raises uncaught.

## DynamoDB-side races

- **`GetItemCommand` at line 29-31** is **eventually consistent** (default). If A advanced `setupStatus` < 1 s ago, B may still read the old status and re-run that step. This widens the race window beyond strict simultaneity — even a request 100 ms after another can land in the same branch.
- **Conditional `UpdateItemCommand`** is the right primitive — Dynamo guarantees a single linear sequence of conditional updates per item. The mechanism works; the **handling** of `ConditionalCheckFailedException` is what's missing. Today every "I lost the race" outcome is reported to the user as a 500.
- **`PutItemCommand` in create-access-key** (`handlers/create-access-key.ts:99-116`) uses `ACCESSKEY#<id>` as `sk`, where `id` comes from Aurora and is unique per call, so the row itself can't collide. The race is upstream (`createAuroraAccessKey` returning `DuplicateKeyNameError` because the _keyName_ collided).

## What SQS was giving us (and what we lose)

The FIFO queue in `trigger-tenant-setup.ts:5-14` provides:

| Property      | Mechanism                       | Concrete effect                                                                                        |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Dedup         | `MessageDeduplicationId: orgId` | 5-minute window in which duplicate sends are silently dropped                                          |
| Serialization | `MessageGroupId: orgId`         | Even if two messages slip through dedup, only one Lambda runs at a time for a given org                |
| Retries       | Visibility timeout 90 s + DLQ   | Auto-retry on transient failures; tail-latency cases ride the next retry instead of the user's request |
| Async UX      | Decoupled handler               | User-facing API never blocks on Aurora                                                                 |

With Aurora setup p99 <10 s, the async-decoupling and retry properties carry less weight than they would with a slow setup — the everyday path completes well within a single API request. **Dedup remains the single biggest defense** removed by the move. Without it, every race window above becomes reachable in practice.

## Summary of hazards

1. **Loser-of-race on `createTenantToken`** — Aurora's 409 prevents a token leak, but our code surfaces it as a 500 (no handler). Concurrent calls always produce one failed request.
2. **No recovery for crash-after-create-before-SSM in `createAndStoreApiKey`** — symmetric to the S3 access key edge case, but `createAndStoreApiKey` has no recovery branch. Once entered, the chain stays stuck forever.
3. **False "secret lost" failure** in `createAndStoreS3AccessKey` recovery path — check-then-act race on SSM. Existing logic works only for sequential retries.
4. **`ConditionalCheckFailedException` not caught** anywhere — every concurrent loser becomes a 500 instead of being recognized as "another invocation already did this; re-read and continue/return."
5. **Stale reads from eventually-consistent `GetItemCommand`** — widens every race window from "truly concurrent" to "within a few hundred ms."
6. **Tail-latency `runSetup`** — usually a single round-trip, but the >10 s p99-and-beyond tail needs either inline polling or a 503 fallback.

## Why we are not adding a single-flight guard

The obvious heavyweight fix is a single-flight guard at the top of `processTenantSetup` (conditional Dynamo claim + TTL). It does work, but it isn't required if every step is independently safe under concurrency. Without the guard, concurrent invocations become a _waste-of-work_ problem rather than a _correctness_ problem — with one corner case: the truly-lost-secret recovery.

We considered three options for that corner case:

1. **Don't auto-recover**: detect, throw loudly, require manual operator intervention.
2. **Auto-recover via delete-then-recreate**, no guard.
3. **Single-flight only the recovery path**.

Option 2 is unsafe. Three concurrent requests (A healthy but slow, B in retry, C arriving) can race the delete-then-recreate path; if a retry budget mis-classifies a slow healthy winner as crashed, the recovery deletes the winner's still-valid Aurora resource after the winner's SSM write has begun — leaving SSM populated with a dead secret and a fresh orphan in Aurora.

Option 3 reintroduces the guard, just scoped tighter. We choose **Option 1**: the lost-secret window is narrow (a Lambda crash inside the ~100 ms gap between Aurora 201 and SSM `PutParameter`), the case is rare, and surfacing it as a loud operator-actionable error is better than risking corrupting consistency with cheap auto-recovery.

## Unifying `createAndStoreApiKey` and `createAndStoreS3AccessKey`

Structurally, both functions do the same thing: provision a deterministically-named credential in Aurora, store the secret in SSM, advance the state machine by one notch. They differ only in:

| Aspect                         | `createAndStoreApiKey`                                            | `createAndStoreS3AccessKey`                                      |
| ------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Underlying Aurora API          | Backoffice `createTenantToken` (`aurora-backoffice.ts:192-229`)   | Portal `createAuroraAccessKey` (`aurora-portal.ts:156-`)         |
| Resource name                  | `filone-${orgId}` (per-org)                                       | `filone-console` (constant per tenant)                           |
| 409 handler                    | **None** — falls through to generic `Error`                       | **Yes** — `DuplicateKeyNameError` typed, recovery branch present |
| SSM path                       | `/filone/${stage}/aurora-portal/tenant-api-key/${auroraTenantId}` | `/filone/${stage}/aurora-s3/access-key/${auroraTenantId}`        |
| SSM value shape                | raw token string                                                  | JSON `{ accessKeyId, secretAccessKey }`                          |
| Recovery behavior on duplicate | n/a (no handler)                                                  | one-shot SSM check, throw if absent                              |
| Permissions arg                | none                                                              | takes `ACCESS_KEY_PERMISSIONS`                                   |
| Status transition              | `AURORA_TENANT_SETUP_COMPLETE → AURORA_TENANT_API_KEY_CREATED`    | `AURORA_TENANT_API_KEY_CREATED → AURORA_S3_ACCESS_KEY_CREATED`   |

### Proposed unified design

Extract one helper, `createOrRecoverCredential`, that both step functions call. Caller injects the parts that differ; the helper owns:

- the duplicate-name path,
- the bounded SSM retry that absorbs concurrent-healthy races,
- the loud failure when the secret is truly lost,
- the conditional status advance.

```ts
type CredentialKind = 'tenant-api-key' | 's3-access-key';

interface ProvisionCredentialOptions {
  kind: CredentialKind;
  ssmName: string;
  expectedStatus: OrgSetupStatus;
  nextStatus: OrgSetupStatus;
  orgKey: Record<string, { S: string }>;
  create: () => Promise<string>; // returns the SSM-ready string
  isDuplicateNameError: (err: unknown) => boolean;
}

async function createOrRecoverCredential(opts: ProvisionCredentialOptions): Promise<void> {
  let secret: string;
  try {
    secret = await opts.create();
  } catch (err) {
    if (!opts.isDuplicateNameError(err)) throw err;
    await recoverFromDuplicate(opts, err);
    return;
  }

  await ssm.send(
    new PutParameterCommand({
      Name: opts.ssmName,
      Value: secret,
      Type: 'SecureString',
      Overwrite: true,
    }),
  );

  await advanceStatus(opts);
}

async function recoverFromDuplicate(
  opts: ProvisionCredentialOptions,
  cause: unknown,
): Promise<void> {
  // Absorb the concurrent-healthy race: another invocation may be milliseconds
  // away from writing SSM. Poll briefly before giving up.
  const backoffsMs = [100, 250, 500, 1000];
  for (const wait of [0, ...backoffsMs]) {
    if (wait) await sleep(wait);
    if (await ssmHasParameter(opts.ssmName)) {
      await advanceStatus(opts);
      return;
    }
  }

  // Truly lost: Aurora has the credential, SSM does not, and no concurrent
  // writer surfaced one in ~2 s. Require manual remediation.
  throw new Error(
    `Lost secret for ${opts.kind} on tenant ${opts.orgKey.pk.S}: ` +
      `Aurora reports the credential exists but SSM ${opts.ssmName} is empty. ` +
      `Manual intervention required: delete the credential in Aurora and retry.`,
    { cause },
  );
}
```

`createAndStoreApiKey` and `createAndStoreS3AccessKey` collapse to thin wrappers that build the options and call the helper. To make the API-key side wire in cleanly, `aurora-backoffice.ts:192-229` needs a typed `DuplicateTokenNameError` (symmetric to `DuplicateKeyNameError` in `aurora-portal.ts:31`) that the helper's `isDuplicateNameError` matches on.

## Minimum hardening required for the synchronous move

- Catch `ConditionalCheckFailedException` in every status-advance write; on hit, re-read state and either continue or short-circuit.
- Switch the orchestrator's `GetItem` to `ConsistentRead: true`.
- Unify `createAndStoreApiKey` and `createAndStoreS3AccessKey` behind `createOrRecoverCredential`:
  - Introduce `DuplicateTokenNameError` in `aurora-backoffice.ts`.
  - Bounded SSM retry on duplicate-name to absorb concurrent-healthy races.
  - On confirmed lost-secret, throw a clear "manual remediation required" error with the orphan's identity in the message; alert operators rather than auto-recovering.
- For `runSetup`, poll with a short backoff (up to ~8 s total) before giving up and returning 503; the everyday Aurora setup case finishes inline and the rare tail rides the next SQS retry (or, post-sync-move, falls back to client retry).
- **No single-flight guard required.** Concurrent invocations are correct under these rules; the cost is duplicated Aurora calls and worse latency on losing requests, both acceptable at our scale.

## Residual risks accepted under this design

- A Lambda crash inside the ~100 ms post-Aurora-201, pre-SSM-write window leaves an orphan credential in Aurora. Subsequent attempts surface a 500 and require operator action. Rare; visible; not silently corrupting.
- Concurrent invocations duplicate the Aurora API call volume per step. Aurora dedupes via 409s; cost is bandwidth and rate-limit headroom, not correctness.
- For `runSetup`, the (rare) >30 s Aurora setup case returns 503 to the user and relies on client retry.

## Implemented (2026-05-12)

The hardening above is now live in `packages/backend/src/lib/aurora-tenant-setup.ts`. `processTenantSetup` still runs from the FIFO SQS queue with per-org dedup; the synchronous move into `create-bucket` / `create-access-key` is deferred to a future change.

What landed:

- **Strong-consistent entry-point read.** `processTenantSetup` issues `GetItemCommand` with `ConsistentRead: true`, so we don't re-run a step a prior invocation finished milliseconds ago.
- **Race-tolerant status advances.** A new `advanceStatus` helper wraps every conditional `UpdateItemCommand`. It catches `ConditionalCheckFailedException` and returns `'already-advanced'`. `createTenant` re-reads with strong consistency to fetch the winner's `auroraTenantId`; the other three sites simply continue/return.
- **Typed duplicate-name error for the backoffice API.** `DuplicateTokenNameError` is exported from `aurora-backoffice.ts`; `createAuroraTenantApiKey` throws it on HTTP 409 (symmetric to `DuplicateKeyNameError` in `aurora-portal.ts`).
- **Recovery branch in `createAndStoreApiKey`.** On `DuplicateTokenNameError`, the function checks SSM (via the polling helper below); if the token is already stored, status advances. If not, the typed error re-throws into SQS retries → DLQ → existing DLQ alert.
- **Bounded SSM poll on duplicate-name.** Both credential recovery branches now poll SSM on the `[20, 50, 100, 250, 500] ms` schedule (~920 ms total of waits) before declaring the secret truly lost. This absorbs the narrow concurrent-healthy race window without dragging out the genuinely-lost case.
- **`runSetup` inline polling.** `setupAuroraTenant` is now retried on a `[100, 200, 500, 1000, 2000, 4000] ms` schedule (7 attempts, ~7.8 s of waits) until `lastSetupStep === 'FINISHED'`. The everyday case completes inline within a single Lambda invocation; the rare >7.8 s tail is left to SQS retries.

Deferred from "Unifying `createAndStoreApiKey` and `createAndStoreS3AccessKey`":

- The full `createOrRecoverCredential` extraction was **not** taken. The recovery branches still live inline in each function, sharing only the small `ssmHasParameter` and `advanceStatus` helpers. The unification can happen alongside the future synchronous-invocation change if it becomes worthwhile then.
- A separate "manual remediation required" error class was also skipped. On a confirmed lost secret we re-throw the typed duplicate-name error (`DuplicateTokenNameError` / `DuplicateKeyNameError`) and rely on the existing SQS retry → DLQ → DLQ alert pathway, which is already the operator-actionable signal.

Test coverage in `aurora-tenant-setup.test.ts` now includes: `ConsistentRead` on the entry-point read; a race-loss test at each of the four status-advance sites; the SSM poll succeeding on a later attempt and exhausting (for both credential types); and `runSetup` reaching `FINISHED` after multiple polls vs. timing out.
