import type { S3Region } from '@filone/shared';
import { isRagCompanionBucket } from '@filone/shared';
import { getAvailableOrchestrators } from './service-orchestrator-registry.ts';
import { getScopedMemberId } from './member-scope.ts';
import { getOrgProfile } from './org-profile.ts';
import type { BucketSummary } from './service-orchestrator.ts';
import type { UserInfo } from './user-context.ts';

export interface OrgBucketListing {
  buckets: BucketSummary[];
  unavailableRegions: S3Region[];
  /** Every provisioned network failed, so an empty list is an outage, not "no buckets". */
  allFailed: boolean;
}

/**
 * The caller's buckets across every network provisioned for their org,
 * optionally narrowed to one region.
 */
export async function listOrgBuckets(
  { orgId, userId, membership }: Pick<UserInfo, 'orgId' | 'userId' | 'membership'>,
  { region, signal }: { region?: string; signal?: AbortSignal },
): Promise<OrgBucketListing> {
  // An orchestrator is one storage network and lists every region it serves in
  // one call, so a region filter skips the networks that do not serve the region.
  const orchestrators = getAvailableOrchestrators().filter(
    (orchestrator) => !region || orchestrator.regions.includes(region as S3Region),
  );
  const orgProfile = await getOrgProfile(orgId);

  // A not-ready orchestrator is simply absent from this org's provisioned regions, not a failed
  // leg: it must not be called, and it must not count toward allFailed.
  const ready = orchestrators.flatMap((orchestrator) => {
    const tenantId = orchestrator.isTenantReady(orgProfile);
    return tenantId ? [{ orchestrator, tenantId }] : [];
  });

  // Fail open (FIL-1049): one region's ListBuckets 403 used to collapse the whole request into a
  // generic 500, hiding the healthy regions' buckets. Return what answered, name what did not.
  const settled = await Promise.allSettled(
    // The member id scopes the listing on a region serving the `iam` access
    // model, where a bucket is accessible only through a policy naming them;
    // every other region ignores it and answers tenant-wide as before.
    ready.map(({ orchestrator, tenantId }) =>
      orchestrator.listBuckets(tenantId, getScopedMemberId(membership?.role, userId), { signal }),
    ),
  );

  const buckets: BucketSummary[] = [];
  const unavailableRegions: S3Region[] = [];
  // Failed calls are counted apart from regions: one failed network may account
  // for several unavailable regions, and the all-failed check is per call.
  let failedOrchestratorCalls = 0;
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      // Bucket Intelligence keeps its Lance datasets in companion buckets on
      // Forge storage; they hold no user data and are not the user's to manage.
      // A network answers for every region it serves, so a region filter is
      // applied to its buckets here rather than by skipping the call.
      buckets.push(
        ...result.value.filter(
          (bucket) =>
            !isRagCompanionBucket(bucket.bucketName) && (!region || bucket.region === region),
        ),
      );
      return;
    }
    const { orchestrator, tenantId } = ready[index];
    // The reason stays here: it carries orchestrator internals that must not reach the caller,
    // and an S3 AccessDenied string means nothing to a user. The caller learns only the region.
    console.error('[list-buckets] Orchestrator listBuckets failed', {
      orgId,
      orchestratorId: orchestrator.id,
      regions: orchestrator.regions,
      tenantId,
      error: result.reason,
    });
    failedOrchestratorCalls++;
    // Every region the network serves is unavailable with it, or just the one
    // asked for when the request was narrowed to it.
    unavailableRegions.push(
      ...orchestrator.regions.filter((served) => !region || served === region),
    );
  });

  // The `> 0` guard keeps an org with no provisioned networks out of allFailed.
  const allFailed = failedOrchestratorCalls > 0 && failedOrchestratorCalls === ready.length;
  return { buckets, unavailableRegions, allFailed };
}
