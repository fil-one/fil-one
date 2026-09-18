// What the console does on behalf of one member on a region serving the `iam`
// access model: which credential signs, and which buckets the member sees.
// Split out of orchestrator.ts, as principals.ts is, so the recovery and
// filtering paths can be read and tested on their own.

import { AccessKeyAlreadyExistsError } from '../errors.ts';
import type { IamMethods } from '../iam-orchestrator.ts';
import { getMemberS3Credentials, memberConsoleKeyName } from '../s3-credentials.ts';
import type { S3Credentials } from '../s3-credentials.ts';
import type { BucketSummary, S3ActorOptions } from '../service-orchestrator.ts';

/** What minting needs from the orchestrator that owns the tenant. */
export interface MemberKeyDeps {
  iam: IamMethods;
  findAccessKeyByName(
    tenantId: string,
    keyName: string,
  ): Promise<{ id: string; accessKeyId: string; createdAt: string } | undefined>;
  deleteAccessKey(tenantId: string, keyId: string): Promise<void>;
}

/**
 * Mints the console's key for one member, or recovers it.
 *
 * `syncMember` runs first because the read paths reach this through
 * `isTenantReady`, which registers no principals — `registerMemberPrincipals`
 * runs only from `ensureTenantReady` — so a member invited after tenant setup
 * may not be a principal yet. It is idempotent and only on the cold path.
 */
export async function mintMemberConsoleKey(
  deps: MemberKeyDeps,
  tenantId: string,
  userId: string,
): Promise<S3Credentials> {
  const keyName = memberConsoleKeyName(userId);
  await deps.iam.syncMember(tenantId, userId);
  try {
    return await issue(deps, tenantId, userId, keyName);
  } catch (err) {
    if (!(err instanceof AccessKeyAlreadyExistsError)) throw err;
    // The key exists but no secret is stored for it: a previous request died
    // between the mint and the parameter write, and the storage system returns a
    // secret only on creation. Drop the orphan and mint again, as tenant setup
    // already does for the tenant's own console key. A container that did store
    // its secret loses that key here and re-mints on its next request, which
    // costs a signing failure and never a wrong answer.
    const orphan = await deps.findAccessKeyByName(tenantId, keyName);
    if (!orphan) throw err;
    await deps.deleteAccessKey(tenantId, orphan.id);
    return issue(deps, tenantId, userId, keyName);
  }
}

async function issue(
  deps: MemberKeyDeps,
  tenantId: string,
  userId: string,
  keyName: string,
): Promise<S3Credentials> {
  // Unexpiring on purpose: a credential's remaining life caps the share links a
  // member can sign, so an expiry here would shorten them.
  const issued = await deps.iam.issueMemberKey(tenantId, userId, { keyName, expiresAt: null });
  return { accessKeyId: issued.accessKeyId, secretAccessKey: issued.accessKeySecret };
}

/**
 * The member's principal-bound credential on this orchestrator, minted on first
 * use.
 *
 * A member's key carries no authority of its own: what it may do is whatever the
 * bucket policies give them at the time of each request. So a role change or a
 * policy edit needs no reissue, and a demotion deletes nothing — rewriting the
 * policies is the narrowing.
 */
export function memberCredentials(
  deps: MemberKeyDeps,
  args: { orchestratorId: string; stage: string; tenantId: string; userId: string },
  requestOptions?: S3ActorOptions,
): Promise<S3Credentials> {
  return getMemberS3Credentials(
    { ...args, mint: () => mintMemberConsoleKey(deps, args.tenantId, args.userId) },
    requestOptions,
  );
}

/**
 * The buckets in a tenant listing that one member can actually reach.
 *
 * The console filters because the data plane does not: every principal holds
 * `s3:ListAllMyBuckets`, so the gateway answers with the tenant's whole set by
 * design (RFC#30) and a principal-bound key would return the same names. The
 * reachable set comes from the storage system's own evaluation, so it agrees
 * with its last policy write.
 *
 * A bucket carrying no policy is absent from every member's reachable set, so
 * only a caller who names no member sees it. The handler decides that: an
 * Owner or an Admin is unscoped and never reaches this filter.
 */
export async function reachableBuckets(
  iam: IamMethods,
  buckets: BucketSummary[],
  tenantId: string,
  userId: string,
): Promise<BucketSummary[]> {
  const access = await iam.resolveMemberAccess(tenantId, userId);
  const reachable = new Set(access.map((entry) => entry.bucketName));
  return buckets.filter((bucket) => reachable.has(bucket.bucketName));
}
