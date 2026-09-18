// What the console does on behalf of one member on a region serving the `iam`
// access model: which buckets the member reaches. Split out of orchestrator.ts,
// as principals.ts is, so the filtering path can be read and tested on its own.

import type { IamMethods } from '../iam-orchestrator.ts';
import type { BucketSummary } from '../service-orchestrator.ts';

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
