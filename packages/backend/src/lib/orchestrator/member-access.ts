// What the console does on behalf of one member on a region serving the `iam`
// access model: which buckets the member can access.

import type { MemberOrchestrator } from '../member-orchestrator.ts';
import type { BucketSummary, ListBucketsOptions } from '../service-orchestrator.ts';

/**
 * The buckets in a tenant listing that one member can actually access. The
 * access lookup runs beside the listing; a failed lookup rejects, so the
 * caller's fan-out reports the region as unavailable rather than handing the
 * member every bucket name in the tenant.
 *
 * The console filters because the data plane does not: every principal holds
 * `s3:ListAllMyBuckets`, so the gateway answers with the tenant's whole set by
 * design (RFC#30) and a principal-bound key would return the same names. The
 * accessible set comes from the storage system's own evaluation, so it agrees
 * with its last policy write.
 *
 * A bucket carrying no policy is absent from every member's accessible set, so
 * only a caller who names no member sees it. The handler decides that: an
 * Owner or an Admin is unscoped and never gets to this filter.
 */
export async function filterBucketsByMemberAccess(
  members: MemberOrchestrator,
  buckets: Promise<BucketSummary[]>,
  tenantId: string,
  requestOptions: ListBucketsOptions & { scopeToMemberId: string },
): Promise<BucketSummary[]> {
  const [listedBuckets, access] = await Promise.all([
    buckets,
    members.resolveMemberAccess(tenantId, requestOptions.scopeToMemberId, {
      signal: requestOptions.signal,
    }),
  ]);
  const accessibleBucketNames = new Set(access.map((entry) => entry.bucketName));
  return listedBuckets.filter((bucket) => accessibleBucketNames.has(bucket.bucketName));
}
