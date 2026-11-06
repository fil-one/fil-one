// Which orchestrator serves each region, as a name. The registry answers the
// same question with a built orchestrator, and building one reads a linked
// secret, so a bin/ script running outside `sst shell` cannot ask it. This
// module reads nothing at import and loads under plain node.

import {
  NETWORK_ID_BY_REGION,
  networkIdForRegion,
  regionsForNetwork,
  S3Region,
  supportsIamMethods,
  type StageLike,
  type NonEmptyArray,
} from '@filone/shared';

/**
 * The orchestrator behind each region, by the id it stores on the account
 * profile as `{orchestratorId}TenantId` and in the SSM path
 * `/filone/{stage}/{orchestratorId}-s3/...`. The type makes a new member of
 * {@link S3Region} fail to compile until it has an entry here; the registry
 * test holds every built orchestrator's id to this map.
 */
export const ORCHESTRATOR_ID_BY_REGION = NETWORK_ID_BY_REGION;

/** The orchestrator id behind a region, or undefined for a region the product does not know. */
export const orchestratorIdForRegion = networkIdForRegion;

/**
 * The regions an orchestrator serves on a stage, in {@link S3Region} order. An
 * orchestrator is one storage network (Aurora, FTH, or one Forge network's
 * Hilt); a tenant on it is region-free, so its access keys work at every one of
 * these regions and its buckets may live in any of them. Pure: it reads no
 * secret and builds nothing, so the console-facing key mapping can use it.
 */
export function regionsForOrchestrator(id: string, stage: StageLike): S3Region[] {
  return regionsForNetwork(id, stage);
}

/**
 * Whether a network serves the `iam` access model: buckets carry policies, and
 * each member is a principal a policy can name. The model belongs to the
 * network, so every region it serves answers the same; the registry test holds
 * every built orchestrator to that.
 */
export function orchestratorSupportsIamMethods(orchestrator: {
  regions: NonEmptyArray<S3Region>;
}): boolean {
  return supportsIamMethods(orchestrator.regions[0]);
}

/**
 * Refuses a region the network does not serve. Every caller is expected to name
 * one of the network's own regions; one that does not is a routing bug upstream,
 * and acting on it would reach the wrong gateway. A single-region network uses
 * this to catch the mistake at the call rather than somewhere downstream.
 */
export function assertServesRegion(
  network: { id: string; regions: readonly S3Region[] },
  region: S3Region,
): void {
  if (!network.regions.includes(region)) {
    throw new Error(`Orchestrator "${network.id}" does not serve region "${region}".`);
  }
}
