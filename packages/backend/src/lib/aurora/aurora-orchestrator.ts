// Aurora-backed ServiceOrchestrator. Delegates to the existing per-call modules
// (aurora-tenant-setup for the lazy setup state machine, aurora-portal for
// bucket and access-key ops) and looks up SSM-cached S3 credentials directly.
//
// PROFILE-row attributes used: `auroraTenantId` and `auroraSetupStatus`.

import pRetry from 'p-retry';
import { S3Region, getS3Endpoint, TenantStatus } from '@filone/shared';
import type {
  AccessKeyPermission,
  Bucket,
  GranularPermission,
  RetentionDurationType,
  RetentionMode,
  S3Region as S3RegionType,
} from '@filone/shared';
import { getBucketInfo, listBuckets } from '@filone/aurora-portal-client';
import { ensureTenantReady as ensureAuroraTenantReady } from '../aurora/aurora-tenant-setup.js';
import {
  createAuroraAccessKey,
  createAuroraBucket,
  createPortalClient,
  deleteAuroraAccessKey,
  deleteAuroraPortalApiKey,
  findAuroraAccessKeyByName,
  getAuroraPortalApiKey,
  portalApiKeySsmPath,
} from '../aurora/aurora-portal.js';
import {
  getOperationsSamples,
  getStorageSamples,
  getTenantStatus as getAuroraTenantStatusApi,
  mapFromModelsTenantStatus,
  mapToModelsTenantStatus,
  updateTenantStatus as updateAuroraTenantStatusApi,
  getBucketStorageSamples,
  getTenantInfo,
  type TenantStatusResult,
} from '../aurora/aurora-backoffice.js';
import { isOrgSetupComplete } from '../org-setup-status.js';
import type { OrgProfileItem } from '../org-profile.js';
import {
  consoleS3CredentialsSsmPath,
  deleteConsoleS3Credentials,
  getConsoleS3Credentials,
  _resetS3CredentialsCacheForTesting,
} from '../s3-credentials.js';
import { BucketNotFoundError, NotImplementedError } from '../errors.js';
import type {
  BucketDetails,
  BucketSummary,
  CreateBucketArgs,
  GetTenantUsageMetricsOptions,
  IssueAccessKeyOpts,
  IssuedAccessKey,
  ListBucketsOptions,
  ServiceOrchestrator,
  TenantStatusProbe,
  StorageUsageSample,
  TenantInfo,
  TenantUsageMetrics,
} from '../service-orchestrator.js';
import type { S3ClientContext } from '../s3-client.js';

export const _resetSsmCacheForTesting = () => _resetS3CredentialsCacheForTesting();

function getStage(): string {
  return process.env.FILONE_STAGE!;
}

export const auroraOrchestrator = {
  id: 'aurora',
  region: S3Region.EuWest1 as S3RegionType,

  async ensureTenantReady(orgId): Promise<string | null> {
    const result = await ensureAuroraTenantReady(orgId);
    if (result.ok) return result.auroraTenantId;
    return null;
  },

  isTenantReady(orgProfile: OrgProfileItem | undefined): string | null {
    const tenantId = orgProfile?.auroraTenantId?.S;
    if (!tenantId) return null;
    if (!isOrgSetupComplete(orgProfile?.auroraSetupStatus?.S)) return null;
    return tenantId;
  },

  async updateTenantStatus(tenantId: string, status: TenantStatus): Promise<void> {
    await updateAuroraTenantStatusApi({ tenantId, status: mapToModelsTenantStatus(status) });
  },

  async getTenantStatus(tenantId: string): Promise<TenantStatusProbe> {
    const result = await getAuroraTenantStatusApi({ tenantId });
    if (result.kind !== 'ok') return result;
    return {
      kind: 'ok',
      status: result.status ? mapFromModelsTenantStatus(result.status) : undefined,
    };
  },

  async deleteTenant(tenantId: string): Promise<void> {
    // Aurora exposes no tenant DELETE, so this is disable + secret-shred only
    // and customer data survives. See
    // docs/architectural-decisions/2026-08-tenant-deletion-semantics.md.
    //
    // ⚠️ THROWING HERE BLOCKS THE ACCOUNT'S DYNAMODB PURGE. This runs inside
    // the account-deletion teardown, whose region loop aggregates orchestrator
    // failures and rethrows *before* `purgeRecords`. So any error escaping
    // deleteTenant — including the post-teardown verification below — leaves
    // in place the ORG# rows (access keys, RAG keys), the RAGKEYHASH# lookup
    // rows, the USER# profiles, the PII attributes on the SUB# identity rows,
    // the CUSTOMER# billing rows and the deletion challenge, and skips both
    // the second (index-lag) Stripe discovery pass and `markDone`.
    //
    // It does NOT block everything, and claiming otherwise would overstate the
    // stakes: `applyDeletionGuards` writes the SUB# `deleted` tombstone at the
    // TOP of the run (as does the confirm handler before its 200), so every
    // session is already dead; and the Stripe cancel + tombstone + redaction
    // job run in the same `Promise.allSettled` batch as this teardown, so the
    // first-pass redaction is created and persisted even when this throws.
    //
    // The blocked purge is still the accepted trade (a live tenant must never
    // be marked deleted), which is exactly why every failure path here must be
    // exitable by retrying — or, where no retry can exit it, must say plainly
    // what it observed and what an operator has to do.
    //
    // Same bounded budget as FTH and the shared orchestrator, for the same
    // reason: to outlast a competing writer that re-activates the tenant
    // between our disable and our verification, and to absorb a transient 5xx
    // on the verification probe rather than escalating it into a blocked purge.
    // Every step below is idempotent, so a re-attempt converges.
    const run: AuroraTeardownRun = { consoleKeyRevoked: false, secretsAlreadyShredded: false };
    await pRetry(() => runAuroraTeardownAttempt(tenantId, run), TENANT_DELETE_RETRY);
  },

  async createBucket(tenantId: string, args: CreateBucketArgs): Promise<void> {
    await createAuroraBucket({
      tenantId,
      bucketName: args.bucketName,
      versioning: args.versioning,
      lock: args.lock,
      retention: args.retention as
        | {
            enabled: boolean;
            mode: RetentionMode;
            duration: number;
            durationType: RetentionDurationType;
          }
        | undefined,
    });
  },

  async deleteBucket(_tenantId: string, _bucketName: string): Promise<void> {
    // TODO: Implement bucket deletion.
    // https://linear.app/filecoin-foundation/issue/FIL-204/delete-bucket
    throw new NotImplementedError('Aurora bucket deletion is not yet supported. See FIL-204.');
  },

  async listBuckets(tenantId: string, opts: ListBucketsOptions = {}): Promise<BucketSummary[]> {
    // Aurora returns versioning inline via `flags`, so there's no per-bucket
    // cost to skip; the option is honored only to keep the contract uniform
    // with FTH (see ListBucketsOptions).
    const includeVersioning = opts.includeVersioning ?? true;
    const client = await createPortalClient(tenantId);
    const { data, error } = await listBuckets({
      client,
      path: { tenantId },
      throwOnError: false,
    });

    if (error) {
      throw new Error(`Failed to list buckets from Aurora for tenant ${tenantId}`, {
        cause: error,
      });
    }

    return (data?.items ?? [])
      .filter((b): b is typeof b & { name: string; createdAt: string } => !!b.name && !!b.createdAt)
      .map((b) => ({
        bucketName: b.name,
        region: auroraOrchestrator.region,
        createdAt: b.createdAt,
        isPublic: false,
        versioning: includeVersioning ? (b.flags?.includes('versioned') ?? false) : false,
        encrypted: b.flags?.includes('encrypted') ?? true,
      }));
  },

  async getBucket(tenantId: string, bucketName: string): Promise<BucketDetails | null> {
    const client = await createPortalClient(tenantId);
    const { data, error, response } = await getBucketInfo({
      client,
      path: { tenantId, bucketName },
      throwOnError: false,
    });

    if (error) {
      if (response?.status === 404) return null;
      throw new Error(`Failed to get bucket "${bucketName}" from Aurora for tenant ${tenantId}`, {
        cause: error,
      });
    }

    if (!data?.createdAt) {
      throw new Error(
        `Aurora returned incomplete data for bucket "${bucketName}" (tenant ${tenantId})`,
      );
    }

    const defaultRetention =
      data.defaultRetention && data.defaultRetention !== 'off'
        ? (data.defaultRetention as Bucket['defaultRetention'])
        : undefined;

    return {
      bucketName: data.name ?? bucketName,
      region: auroraOrchestrator.region,
      createdAt: data.createdAt,
      isPublic: false,
      objectLockEnabled: data.objectLock ?? false,
      versioning: data.versioning ?? false,
      encrypted: data.encrypted ?? true,
      defaultRetention,
      retentionDuration: data.retentionDuration ?? undefined,
      retentionDurationType:
        (data.retentionDurationType as RetentionDurationType | undefined) ?? undefined,
    };
  },

  async issueAccessKey(tenantId: string, opts: IssueAccessKeyOpts): Promise<IssuedAccessKey> {
    const key = await createAuroraAccessKey({
      tenantId,
      keyName: opts.keyName,
      permissions: opts.permissions as AccessKeyPermission[],
      granularPermissions: opts.granularPermissions as GranularPermission[] | undefined,
      buckets: opts.buckets,
      expiresAt: opts.expiresAt,
    });
    return {
      id: key.id,
      accessKeyId: key.accessKeyId,
      accessKeySecret: key.accessKeySecret,
      createdAt: key.createdAt,
    };
  },

  async findAccessKeyByName(tenantId: string, keyName: string) {
    return findAuroraAccessKeyByName({ tenantId, keyName });
  },

  async deleteAccessKey(tenantId: string, keyId: string): Promise<void> {
    await deleteAuroraAccessKey({ tenantId, auroraKeyId: keyId });
  },

  async getS3ClientContext(tenantId: string): Promise<S3ClientContext> {
    const stage = getStage();
    const credentials = await getConsoleS3Credentials({
      orchestratorId: auroraOrchestrator.id,
      stage,
      tenantId,
    });
    return {
      endpointUrl: getS3Endpoint(S3Region.EuWest1, stage),
      region: 'auto',
      credentials,
      forcePathStyle: true,
      orchestratorId: auroraOrchestrator.id,
      tenantId,
    };
  },

  async getTenantUsageMetrics(
    tenantId: string,
    opts: GetTenantUsageMetricsOptions,
  ): Promise<TenantUsageMetrics> {
    const window = mapIntervalToAuroraWindow(opts.interval ?? '1d');
    const { from, to } = opts;

    const [storageSamples, operationsSamples] = await Promise.all([
      getStorageSamples({ tenantId, from, to, window }),
      getOperationsSamples({ tenantId, from, to, window }),
    ]);

    const storage = storageSamples
      .filter((s): s is typeof s & { timestamp: string } => s.timestamp !== undefined)
      .map((s) => ({
        timestamp: new Date(s.timestamp).toISOString(),
        bytesUsed: s.bytesUsed ?? 0,
        objectCount: s.objectCount ?? 0,
      }));

    const egress = operationsSamples
      .filter((s): s is typeof s & { timestamp: string } => s.timestamp !== undefined)
      .map((s) => ({
        timestamp: new Date(s.timestamp).toISOString(),
        bytesUsed: s.txBytes ?? 0,
      }));

    return { storage, egress };
  },

  async getTenantInfo(tenantId: string): Promise<TenantInfo> {
    const info = await getTenantInfo({ tenantId });
    return {
      bucketCount: info.bucketCount ?? 0,
      bucketLimit: info.bucketQuantityLimit ?? 100,
      keyCount: info.keyCount ?? 0,
      accessKeyLimit: info.accessKeyQuantityLimit ?? 300,
      status: mapFromModelsTenantStatus(info.status),
    };
  },

  async getBucketUsageMetrics(
    tenantId: string,
    bucketName: string,
    opts: GetTenantUsageMetricsOptions,
  ): Promise<StorageUsageSample[]> {
    // getBucketStorageSamples queries Aurora metrics globally by bucket name, so
    // gate it behind a tenant-scoped ownership check: only the owning tenant's
    // Portal client resolves the bucket (404 -> null otherwise).
    const bucket = await auroraOrchestrator.getBucket(tenantId, bucketName);
    if (!bucket) throw new BucketNotFoundError(bucketName);
    const auroraInterval = mapIntervalToAuroraWindow(opts.interval ?? '1d');

    const samples = await getBucketStorageSamples({
      bucketName,
      from: opts.from,
      to: opts.to,
      window: auroraInterval,
    });

    return samples
      .filter((s): s is typeof s & { timestamp: string } => s.timestamp !== undefined)
      .map((s) => ({
        timestamp: new Date(s.timestamp).toISOString(),
        bytesUsed: s.bytesUsed ?? 0,
        objectCount: s.objectCount ?? 0,
      }));
  },
} satisfies ServiceOrchestrator;

// Matches TENANT_DELETE_RETRY in fth-orchestrator.ts and orchestrator.ts.
const TENANT_DELETE_RETRY = { retries: 3 } as const;

/**
 * Carried across the attempts of a single `deleteTenant` call so a later
 * attempt can tell "this run already revoked the console key" from "nobody
 * ever did". Never persisted — a fresh invocation starts pessimistic.
 */
interface AuroraTeardownRun {
  /** This run revoked the console S3 key, or found it already gone upstream. */
  consoleKeyRevoked: boolean;
  /**
   * This pass found BOTH FilOne-held SSM secrets already absent, so an earlier
   * completed teardown owns the revocation decision. Distinguishes the routine
   * repeat pass — `purgeRecords` calls `deleteTenant` a second time for late
   * regions, so every ordinary Aurora deletion runs it twice — from the
   * genuinely anomalous half-shredded state.
   */
  secretsAlreadyShredded: boolean;
}

// One attempt of the teardown. Re-probes on every attempt, so a re-attempt
// re-disables a tenant a competing writer flipped back to active.
async function runAuroraTeardownAttempt(tenantId: string, run: AuroraTeardownRun): Promise<void> {
  // Raw ModelsTenantStatus throughout this path, deliberately: the
  // orchestrator-facing mapping collapses Aurora's LOCKED to `undefined`, and
  // `undefined` also means "Aurora sent no status at all". On a destructive
  // path those two must not be confused, and neither may masquerade as
  // "a competing writer re-activated it".
  const probe = await getAuroraTenantStatusApi({ tenantId });
  if (probe.kind === 'error') {
    throw new Error(`Aurora status probe failed while deleting tenant ${tenantId}`, {
      cause: probe.cause,
    });
  }
  if (probe.kind === 'not_found') {
    await handleUnresolvableTenant(tenantId);
    return;
  }

  if (probe.status !== 'DISABLED') {
    await auroraOrchestrator.updateTenantStatus(tenantId, 'disabled');
  }

  // Must precede the SSM deletes below: reaching the Portal needs the portal
  // API key still in SSM, so afterwards revocation is impossible.
  await revokeConsoleS3AccessKey(tenantId, run);

  await deleteFilOneHeldSecrets(tenantId);

  // Before the verification, and unconditionally: the manual step is pending
  // whenever this function is about to report success, whether or not *this*
  // pass is the one that disabled the tenant. Emitting it only on the
  // disabling pass, after the verification, let an entire successful teardown
  // complete without it ever being logged (pass 1 disables and then fails
  // verification; pass 2 finds the tenant already disabled and no-ops).
  warnAuroraTenantNeedsManualDeletion(tenantId, run);

  await assertTenantDisabledAfterTeardown(tenantId);
}

// Aurora leaves the tenant and all of its customer data in place; only a human
// in the backoffice can remove it. Logged on every successful teardown pass.
function warnAuroraTenantNeedsManualDeletion(tenantId: string, run: AuroraTeardownRun): void {
  const keyState = describeConsoleKeyOutcome(run);
  console.warn(
    `[aurora-orchestrator] Aurora has no remote tenant-deletion API; the tenant is disabled, ` +
      `${keyState}, and the FilOne-held SSM secrets deleted. The Aurora tenant itself, and all ` +
      `of its customer data, still requires a manual backoffice deletion`,
    { tenantId },
  );
}

// Says only what this run established. "NOT confirmed revoked" points at a
// preceding warning, so it may only be used when one was actually emitted.
function describeConsoleKeyOutcome(run: AuroraTeardownRun): string {
  if (run.consoleKeyRevoked) return 'its console S3 key revoked';
  if (run.secretsAlreadyShredded) {
    return 'its console S3 key settled by the earlier pass that shredded the SSM secrets';
  }
  return 'its console S3 key NOT confirmed revoked (see the preceding warning)';
}

async function deleteFilOneHeldSecrets(tenantId: string): Promise<void> {
  await deleteAuroraPortalApiKey(getStage(), tenantId);
  await deleteConsoleS3Credentials(consoleS3CredentialsArgs(tenantId));
}

// A tenant-scoped 404 is ambiguous and CANNOT be disambiguated upstream.
// `getTenantStatus` maps ANY 404 to `not_found`, and a wrong
// AURORA_PARTNER_ID, a misrouted backoffice baseUrl or a wrong-scope token
// 404s every tenant alike — so acting on one would shred the SSM credentials
// of a tenant that is still live and still ACTIVE upstream, with its console
// key unrevoked and no way left to reach the Portal.
//
// Corroborating absence from the backoffice was tried and does not work; see
// the Aurora evidence section of the deletion-semantics ADR (probed 2026-08-10
// against dev). In short: `GetPartner` 403s for our token, `ListTenants`
// clamps `pageSize` to 20 so any walk that stops on a short page reports a
// 239-tenant partner as empty after 20, and `GetTenant` answered 400 rather
// than the declared 404 for an id that does not resolve.
//
// So the decision is made from LOCAL evidence only — whether FilOne still
// holds the tenant's two SSM secrets — and **no 404 ever deletes anything**:
//
//   - both secrets already absent → a previous pass completed this teardown
//     (or an operator did the manual cleanup below). Nothing is left to do;
//     this is the idempotent-completion exit.
//   - either secret still present → refuse, and name the two parameters an
//     operator must delete by hand once they have confirmed upstream. That
//     manual deletion is precisely what lets the next pass take the branch
//     above, so the wedge has a real exit that does not require Aurora
//     permissions FilOne does not hold.
async function handleUnresolvableTenant(tenantId: string): Promise<void> {
  const stage = getStage();
  const held = await readHeldSecrets(stage, tenantId);

  if (!held.portalApiKey && !held.consoleS3Credentials) {
    console.log(
      `[aurora-orchestrator] Aurora tenant ${tenantId} does not resolve and FilOne holds ` +
        'neither of its SSM secrets, so this teardown has already run to completion; nothing ' +
        'to do. (The Aurora tenant itself, if it still exists upstream, needs a manual ' +
        'backoffice deletion.)',
    );
    return;
  }

  const stillHeld = [
    held.portalApiKey ? portalApiKeySsmPath(stage, tenantId) : null,
    held.consoleS3Credentials
      ? consoleS3CredentialsSsmPath(consoleS3CredentialsArgs(tenantId))
      : null,
  ].filter((name): name is string => name !== null);

  throw new Error(
    `Aurora tenant ${tenantId} did not resolve (404) and this teardown will NOT delete its ` +
      'credentials on an unexplained 404: getTenantStatus reports not_found for ANY 404, so a ' +
      'wrong AURORA_PARTNER_ID, a misrouted AURORA_BACKOFFICE_URL or a wrong-scope token 404s ' +
      'a tenant that is still live and ACTIVE upstream. FilOne still holds ' +
      `${stillHeld.join(' and ')}, which is the only way it can reach that tenant and is ` +
      'unrecoverable once deleted (processTenantSetup will not re-mint either secret after ' +
      'auroraSetupStatus goes terminal). To unwedge this deletion an operator must confirm in ' +
      'the Aurora backoffice that the tenant really is gone and then delete ' +
      `${stillHeld.length === 1 ? 'that parameter' : 'those parameters'} by hand; the next ` +
      'teardown pass then finds both secrets absent and completes.',
  );
}

/** Which of the two FilOne-held SSM secrets still exist for a tenant. */
interface HeldAuroraSecrets {
  portalApiKey: boolean;
  consoleS3Credentials: boolean;
}

// Existence read for both FilOne-held secrets, expressed through the getters
// the rest of this module already uses rather than a second SSM client path.
// Both translate SSM's ParameterNotFound — and only that — into a
// `not found in SSM` Error, which revokeConsoleS3AccessKey below already keys
// off. Every other failure (AccessDenied, throttling) propagates, because
// "we could not read it" must never be mistaken for "it is gone". Neither
// secret's value is returned, logged or otherwise retained here.
async function readHeldSecrets(stage: string, tenantId: string): Promise<HeldAuroraSecrets> {
  const [portalApiKey, consoleS3Credentials] = await Promise.all([
    ssmSecretExists(() => getAuroraPortalApiKey(stage, tenantId)),
    consoleS3CredentialsExist(tenantId),
  ]);
  return { portalApiKey, consoleS3Credentials };
}

function consoleS3CredentialsExist(tenantId: string): Promise<boolean> {
  return ssmSecretExists(() => getConsoleS3Credentials(consoleS3CredentialsArgs(tenantId)));
}

function consoleS3CredentialsArgs(tenantId: string) {
  return { orchestratorId: auroraOrchestrator.id, stage: getStage(), tenantId };
}

async function ssmSecretExists(read: () => Promise<unknown>): Promise<boolean> {
  try {
    await read();
    return true;
  } catch (err) {
    if (isSsmParameterMissingError(err)) return false;
    throw err;
  }
}

/** Both SSM getters in this module report a missing parameter with this wording. */
function isSsmParameterMissingError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('not found in SSM');
}

// Post-teardown verification (see deleteTenant for why re-activation is
// possible at all, and for why throwing here is fatal to the account's data
// purge). Compares Aurora's raw status: the orchestrator-facing mapping turns
// LOCKED into `undefined`, which is indistinguishable from an absent status
// field, and neither is evidence of a competing writer.
async function assertTenantDisabledAfterTeardown(tenantId: string): Promise<void> {
  const verify = await getAuroraTenantStatusApi({ tenantId });
  if (verify.kind === 'ok' && verify.status === 'DISABLED') return;

  throw new Error(
    `Aurora tenant ${tenantId} could not be confirmed DISABLED after teardown; the account's ` +
      `data purge is blocked until it can be. ${describeFailedVerification(verify)}`,
    { cause: verify.kind === 'error' ? verify.cause : undefined },
  );
}

// Says only what the probe actually established. Blaming a competing writer for
// a transport error or a 404 is a claim the code cannot support.
function describeFailedVerification(verify: TenantStatusResult): string {
  if (verify.kind === 'error') {
    return (
      'The verification probe itself failed, so the tenant status is unknown; this is ' +
      'usually transient and the retry re-runs the whole teardown.'
    );
  }
  if (verify.kind === 'not_found') {
    return (
      'The verification probe returned 404 although the tenant resolved moments earlier, ' +
      'so the backoffice client stopped resolving mid-teardown rather than the tenant vanishing.'
    );
  }
  if (verify.status === 'ACTIVE' || verify.status === 'WRITE_LOCKED') {
    return (
      `Aurora reports status=${verify.status}: a competing writer re-activated it — one that ` +
      'read the org profile before the `deleting` guard landed. Retrying the teardown ' +
      're-disables it.'
    );
  }
  if (verify.status === 'LOCKED') {
    return (
      'Aurora reports status=LOCKED, which is read-only rather than "denies all actions", ' +
      'so the tenant is NOT torn down and this is not a competing writer re-activating it. ' +
      'The retry does re-issue the disable — the next attempt PATCHes any status other than ' +
      'DISABLED — so if LOCKED survives the retry budget then Aurora is refusing the ' +
      'transition or something is re-locking the tenant, and an operator must set it to ' +
      'DISABLED by hand.'
    );
  }
  return (
    'Aurora returned no tenant status field at all, so the teardown cannot be verified. ' +
    'Retrying will not change it — this needs an operator, not a competing-writer explanation.'
  );
}

// The tenant's console S3 key is provisioned under this name by
// createAndStoreS3AccessKey in aurora-tenant-setup.ts.
const AURORA_CONSOLE_KEY_NAME = 'filone-console';

// Aurora's delete endpoint takes the Portal-internal key id — not the
// accessKeyId stashed in SSM — so resolve it by the well-known key name.
// Idempotent: an already-revoked key is success, and so is a portal API key
// already gone from SSM — but only the first of those is *evidence* of
// revocation. Anything else propagates so the caller retries while the SSM
// copies (and thus automated revocation) still exist.
async function revokeConsoleS3AccessKey(tenantId: string, run: AuroraTeardownRun): Promise<void> {
  let key: Awaited<ReturnType<typeof findAuroraAccessKeyByName>>;
  try {
    key = await findAuroraAccessKeyByName({ tenantId, keyName: AURORA_CONSOLE_KEY_NAME });
  } catch (err) {
    if (isSsmParameterMissingError(err)) {
      await reportUnreachablePortalDuringRevocation(tenantId, run);
      return;
    }
    throw err;
  }
  if (!key) {
    run.consoleKeyRevoked = true;
    console.log(
      `[aurora-orchestrator] console S3 key "${AURORA_CONSOLE_KEY_NAME}" is absent from tenant ${tenantId}'s listing; already revoked`,
    );
    return;
  }
  await deleteAuroraAccessKey({ tenantId, auroraKeyId: key.id });
  run.consoleKeyRevoked = true;
}

// The portal API key is gone from SSM, so the Portal cannot be reached and
// revocation cannot even be attempted. Whether that is benign is decided from
// local evidence, never from an assumption about what an earlier run did:
//
//   - this run already revoked → nothing to report beyond a log.
//   - the console credentials are gone too → an earlier pass reached
//     deleteFilOneHeldSecrets, which only ever runs after revocation was
//     attempted on that pass, so that pass already emitted whatever warning
//     the outcome deserved. This is the ORDINARY repeat pass: purgeRecords
//     calls deleteTenant a second time for late regions, so every normal
//     Aurora deletion lands here once. Warning on it would make the signal
//     below permanent noise.
//   - the console credentials survive while the portal key does not → a
//     genuinely half-shredded state that nothing explains. Warn.
async function reportUnreachablePortalDuringRevocation(
  tenantId: string,
  run: AuroraTeardownRun,
): Promise<void> {
  if (run.consoleKeyRevoked) {
    console.log(
      `[aurora-orchestrator] portal API key already deleted from SSM for tenant ${tenantId}; ` +
        'skipping console S3 key revocation — this run already revoked it',
    );
    return;
  }
  if (!(await consoleS3CredentialsExist(tenantId))) {
    run.secretsAlreadyShredded = true;
    console.log(
      `[aurora-orchestrator] both FilOne-held SSM secrets for tenant ${tenantId} are already ` +
        'gone, so an earlier teardown pass completed and owns the console S3 key outcome; ' +
        'skipping revocation',
    );
    return;
  }
  console.warn(
    `[aurora-orchestrator] portal API key is not in SSM for tenant ${tenantId}, so console S3 ` +
      'key revocation could not be attempted or verified. If no earlier pass revoked it, the ' +
      `"${AURORA_CONSOLE_KEY_NAME}" key may still be LIVE upstream and can no longer be revoked ` +
      'automatically; it needs a manual Aurora backoffice/portal step',
    { tenantId },
  );
}

// Aurora's metrics API only accepts windows in m/h units, so the
// orchestrator-agnostic '1d' value is translated before it hits the wire.
function mapIntervalToAuroraWindow(interval: string): string {
  if (interval === '1d') return '24h';
  return interval;
}
