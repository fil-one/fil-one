// A member's principal at each region serving the `iam` access model: created
// when they join the org and deleted when they are removed. The storage system
// keeps the principal's keys and the statements naming it, so nothing is
// recorded here. A region that refuses throws, and the membership write that
// needed it does not happen; the same request tries again.

import type { S3Region } from '@filone/shared';
import { IamRegionRefusedError } from './errors.ts';
import { getOrgProfile } from './org-profile.ts';
import type { OrgProfileItem } from './org-profile.ts';
import { getAvailableOrchestrators } from './service-orchestrator-registry.ts';
import { supportsBucketPolicies, type ServiceOrchestrator } from './service-orchestrator.ts';

/** The ready `iam` orchestrators for this org, with the tenant each resolved. */
function getReadyIamOrchestrators(
  orgProfile: OrgProfileItem | undefined,
): Array<{ orchestrator: ServiceOrchestrator; tenantId: string }> {
  return getAvailableOrchestrators().flatMap((orchestrator) => {
    if (!supportsBucketPolicies(orchestrator)) return [];
    const tenantId = orchestrator.isTenantReady(orgProfile);
    return tenantId ? [{ orchestrator, tenantId }] : [];
  });
}

/** Runs `call` on every ready `iam` region at once and throws naming the ones that refused. */
async function onEveryReadyIamRegion(
  action: IamRegionRefusedError['action'],
  orgProfile: OrgProfileItem | undefined,
  userId: string,
  call: (orchestrator: ServiceOrchestrator, tenantId: string) => Promise<void>,
): Promise<void> {
  const regions = getReadyIamOrchestrators(orgProfile);
  const outcomes = await Promise.allSettled(
    regions.map(({ orchestrator, tenantId }) => call(orchestrator, tenantId)),
  );
  const failed: S3Region[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') return;
    const { region } = regions[index]!.orchestrator;
    console.error(`[member-principals] Could not ${action} a member's principal`, {
      region,
      userId,
      error: outcome.reason,
    });
    failed.push(region);
  });
  if (failed.length > 0) throw new IamRegionRefusedError(action, failed);
}

/**
 * Creates the principal for a member who just joined, on every ready `iam`
 * region, so a policy can name them and a key can bind to them. Reads the org
 * profile consistently, so a tenant provisioned moments ago is seen.
 */
export async function registerNewMember({
  orgId,
  userId,
}: {
  orgId: string;
  userId: string;
}): Promise<void> {
  if (!getAvailableOrchestrators().some((orchestrator) => supportsBucketPolicies(orchestrator)))
    return;
  const orgProfile = await getOrgProfile(orgId, { consistentRead: true });
  await onEveryReadyIamRegion('register', orgProfile, userId, (orchestrator, tenantId) =>
    orchestrator.syncMember(tenantId, userId),
  );
}

/**
 * Removes a member's principal from every ready `iam` region: their keys and
 * every statement naming them go with it at the storage system.
 */
export async function removeMemberPrincipal({
  orgProfile,
  userId,
}: {
  orgProfile: OrgProfileItem | undefined;
  userId: string;
}): Promise<void> {
  await onEveryReadyIamRegion('remove', orgProfile, userId, (orchestrator, tenantId) =>
    orchestrator.removeMember(tenantId, userId),
  );
}
