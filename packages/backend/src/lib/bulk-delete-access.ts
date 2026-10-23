// Whether a scoped member's bucket policies cover a bulk deletion. The worker
// deletes with the tenant's key, which the storage system never evaluates a
// policy for, so this check is the whole enforcement. The route runs it before
// queueing a job and the worker again before each run, so access revoked after
// the job was queued stops it.

import { BulkDeleteScope, supportsIamMethods, type PolicyAction } from '@filone/shared';

import type { BucketVersioningStatus } from './s3-bucket-operations.ts';
import type { RegionOrchestrator, ServiceOrchestrator } from './service-orchestrator.ts';

/**
 * The policy actions the worker's S3 calls need. An all-versions delete lists
 * versions and deletes by version id, except on a bucket that never enabled
 * versioning: every version there is the literal "null" one, which the worker
 * drops to issue plain object deletes.
 */
function getRequiredActions({ scope, versioningStatus }: BulkDeleteTarget): PolicyAction[] {
  if (scope === BulkDeleteScope.Current) return ['s3:ListBucket', 's3:DeleteObject'];
  return versioningStatus === 'Never'
    ? ['s3:ListBucketVersions', 's3:DeleteObject']
    : ['s3:ListBucketVersions', 's3:DeleteObjectVersion'];
}

/**
 * Why a member may not run a bulk deletion: no policy grants them the bucket,
 * or the bucket's policy lacks an action the scope needs.
 */
export type BulkDeleteRefusalReason = 'bucket-not-granted' | 'action-not-granted';

export interface BulkDeleteAllowed {
  ok: true;
}

export interface BulkDeleteRefused {
  ok: false;
  reason: BulkDeleteRefusalReason;
}

export type BulkDeleteAccess = BulkDeleteAllowed | BulkDeleteRefused;

export interface BulkDeleteTarget {
  bucketName: string;
  scope: BulkDeleteScope;
  versioningStatus: BucketVersioningStatus;
}

/**
 * Whether the member may run this deletion, and why not when they may not. An
 * unscoped caller (no member id), and every region serving service keys, skips
 * the read.
 */
export async function canBulkDelete(
  orchestrator: RegionOrchestrator,
  tenantId: string,
  memberId: string | undefined,
  target: BulkDeleteTarget,
): Promise<BulkDeleteAccess> {
  if (!memberId || !supportsIamMethods(orchestrator.region)) return { ok: true };
  // Every region serving the iam access model has a ServiceOrchestrator, which
  // the compiler cannot tell from the region check.
  const access = await (orchestrator as ServiceOrchestrator).resolveMemberAccess(
    tenantId,
    memberId,
  );
  const granted = access.find((entry) => entry.bucketName === target.bucketName)?.actions;
  if (!granted) return { ok: false, reason: 'bucket-not-granted' };
  const required = getRequiredActions(target);
  if (!required.every((action) => granted.includes(action))) {
    return { ok: false, reason: 'action-not-granted' };
  }
  return { ok: true };
}
